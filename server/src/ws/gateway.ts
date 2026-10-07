import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyAccessToken } from "../lib/auth.js";
import { prisma } from "../db.js";
import { setPresenceInMemory } from "../modules/presence/presenceStore.js";
import {
  countFleetConnections,
  isRedisEnabled,
  markConnectionAlive,
  markConnectionGone,
  newConnectionId,
  publishFanout,
  subscribeFanout,
} from "./presenceFanout.js";

interface ClientMessage {
  type: "typing" | "presence";
  conversationId?: string;
  channelId?: string;
  status?: string;
  customStatus?: string;
}

// Always local to this process - a WebSocket object can't be handed to
// another replica, so each replica only ever delivers to sockets it's
// physically holding open itself. Cross-replica delivery goes through Redis
// pub/sub instead (see presenceFanout.ts) when REDIS_URL is set; with no
// Redis configured, this map is the *only* source of truth, exactly as
// before Redis support existed.
const connections = new Map<string, Set<WebSocket>>();

// A socket that never cleanly closes (laptop sleeps, browser is killed, wifi
// drops) never fires the 'close' event on its own - without this heartbeat,
// such a user would show as online forever. Every HEARTBEAT_MS we ping every
// socket; if one hasn't ponded back since the last check, it's dead and gets
// terminated, which does fire 'close' and correctly flips presence to offline.
const HEARTBEAT_MS = 30_000;
const aliveFlags = new WeakMap<WebSocket, boolean>();
const connectionIds = new WeakMap<WebSocket, string>();

let fanoutSubscribed = false;

// Local-process view only, even when Redis is configured - nothing today
// relies on these being fleet-wide (see countFleetConnections for that), but
// callers should be aware this answers "online on THIS replica", not
// "online anywhere".
export function getOnlineUserIds(): string[] {
  return [...connections.keys()];
}

export function isUserOnline(userId: string): boolean {
  return connections.has(userId);
}

function deliverLocally(userIds: string[], event: unknown) {
  const data = JSON.stringify(event);
  for (const userId of new Set(userIds)) {
    const sockets = connections.get(userId);
    if (!sockets) continue;
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }
}

export function sendToUser(userId: string, event: unknown) {
  sendToUsers([userId], event);
}

export function sendToUsers(userIds: string[], event: unknown) {
  publishFanout(userIds, event)
    .then((published) => {
      // No Redis configured: there's no subscriber to echo this back, so
      // delivery has to happen directly. With Redis, every replica
      // (including this one) receives its own publish via subscribeFanout -
      // delivering it here too would double-send to this replica's sockets.
      if (!published) deliverLocally(userIds, event);
    })
    .catch((err) => {
      console.error("[ws] fanout publish failed, delivering locally only:", err);
      deliverLocally(userIds, event);
    });
}

function extractToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "", "http://internal");
  return url.searchParams.get("token");
}

export function createWebSocketGateway(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  if (!fanoutSubscribed) {
    subscribeFanout(deliverLocally);
    fanoutSubscribed = true;
  }

  wss.on("connection", (socket, req) => {
    const token = extractToken(req);
    if (!token) {
      socket.close(4001, "missing_token");
      return;
    }

    let userId: string;
    try {
      userId = verifyAccessToken(token).sub;
    } catch {
      socket.close(4001, "invalid_token");
      return;
    }

    const connId = newConnectionId();
    connectionIds.set(socket, connId);

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId)!.add(socket);
    aliveFlags.set(socket, true);

    // Every listener below must be attached synchronously, before any
    // `await`. If a socket closes while we're off awaiting something (e.g.
    // the presence DB write just below), a 'close' listener added only
    // afterwards would simply never see that event - Node's EventEmitter
    // doesn't queue events for listeners that arrive late - and the
    // connection would sit in `connections` forever, permanently "online".
    socket.on("pong", () => aliveFlags.set(socket, true));

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "typing") {
        handleTyping(userId, msg).catch((err) => console.error("[ws] typing broadcast failed:", err));
      }
    });

    socket.on("close", () => {
      const set = connections.get(userId);
      set?.delete(socket);
      if (set && set.size === 0) connections.delete(userId);

      handleDisconnect(userId, connId).catch((err) =>
        console.error(`[ws] failed to process disconnect for ${userId}:`, err)
      );
    });

    handleConnect(userId, connId, socket).catch((err) =>
      console.error(`[ws] failed to process connect for ${userId}:`, err)
    );
  });

  const heartbeat = setInterval(() => {
    for (const [userId, sockets] of connections) {
      for (const socket of sockets) {
        if (aliveFlags.get(socket) === false) {
          socket.terminate(); // triggers 'close', which cleans up presence
          continue;
        }
        aliveFlags.set(socket, false);
        socket.ping();
        const connId = connectionIds.get(socket);
        if (connId) {
          markConnectionAlive(userId, connId).catch((err) =>
            console.error(`[ws] failed to refresh presence TTL for ${userId}:`, err)
          );
        }
      }
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

async function handleConnect(userId: string, connId: string, socket: WebSocket) {
  const wasOnlineBefore = isRedisEnabled()
    ? (await countFleetConnections(userId)) > 0
    : isUserOnlineExcluding(userId, socket);
  await markConnectionAlive(userId, connId);
  if (!wasOnlineBefore) {
    await setPresenceInMemory(userId, "ONLINE");
  }
}

async function handleDisconnect(userId: string, connId: string) {
  await markConnectionGone(userId, connId);
  const stillOnline = isRedisEnabled() ? (await countFleetConnections(userId)) > 0 : !!connections.get(userId)?.size;
  if (!stillOnline) {
    await setPresenceInMemory(userId, "OFFLINE");
  }
}

function isUserOnlineExcluding(userId: string, exclude: WebSocket): boolean {
  const set = connections.get(userId);
  if (!set) return false;
  for (const s of set) if (s !== exclude) return true;
  return false;
}

async function handleTyping(userId: string, msg: ClientMessage) {
  if (msg.conversationId) {
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: msg.conversationId },
      select: { userId: true },
    });
    sendToUsers(
      members.map((m) => m.userId).filter((id) => id !== userId),
      { type: "typing", conversationId: msg.conversationId, userId }
    );
  } else if (msg.channelId) {
    const channel = await prisma.channel.findUnique({
      where: { id: msg.channelId },
      select: { communityId: true },
    });
    if (!channel) return;
    const members = await prisma.communityMember.findMany({
      where: { communityId: channel.communityId },
      select: { userId: true },
    });
    sendToUsers(
      members.map((m) => m.userId).filter((id) => id !== userId),
      { type: "typing", channelId: msg.channelId, userId }
    );
  }
}
