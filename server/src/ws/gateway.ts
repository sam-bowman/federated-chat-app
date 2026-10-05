import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyAccessToken } from "../lib/auth.js";
import { prisma } from "../db.js";
import { setPresenceInMemory } from "../modules/presence/presenceStore.js";

interface ClientMessage {
  type: "typing" | "presence";
  conversationId?: string;
  channelId?: string;
  status?: string;
  customStatus?: string;
}

const connections = new Map<string, Set<WebSocket>>();

// A socket that never cleanly closes (laptop sleeps, browser is killed, wifi
// drops) never fires the 'close' event on its own - without this heartbeat,
// such a user would show as online forever. Every HEARTBEAT_MS we ping every
// socket; if one hasn't ponded back since the last check, it's dead and gets
// terminated, which does fire 'close' and correctly flips presence to offline.
const HEARTBEAT_MS = 30_000;
const aliveFlags = new WeakMap<WebSocket, boolean>();

export function getOnlineUserIds(): string[] {
  return [...connections.keys()];
}

export function isUserOnline(userId: string): boolean {
  return connections.has(userId);
}

export function sendToUser(userId: string, event: unknown) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

export function sendToUsers(userIds: string[], event: unknown) {
  for (const id of new Set(userIds)) sendToUser(id, event);
}

function extractToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "", "http://internal");
  return url.searchParams.get("token");
}

export function createWebSocketGateway(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId)!.add(socket);
    aliveFlags.set(socket, true);
    const wasOffline = !isUserOnlineExcluding(userId, socket);

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
      if (set && set.size === 0) {
        connections.delete(userId);
        // A fire-and-forget call whose rejection nobody awaits is an
        // unhandled rejection - which crashes the whole process by default.
        // A token can outlive the user it names (deleted account, or a dev
        // database reset under a client that's still holding an old token),
        // and that must never be allowed to take the server down.
        setPresenceInMemory(userId, "OFFLINE").catch((err) =>
          console.error(`[ws] failed to mark ${userId} offline:`, err)
        );
      }
    });

    if (wasOffline) {
      setPresenceInMemory(userId, "ONLINE").catch((err) => console.error(`[ws] failed to mark ${userId} online:`, err));
    }
  });

  const heartbeat = setInterval(() => {
    for (const sockets of connections.values()) {
      for (const socket of sockets) {
        if (aliveFlags.get(socket) === false) {
          socket.terminate(); // triggers 'close', which cleans up presence
          continue;
        }
        aliveFlags.set(socket, false);
        socket.ping();
      }
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
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
