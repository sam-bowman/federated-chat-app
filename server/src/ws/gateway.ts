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

  wss.on("connection", async (socket, req) => {
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

    const wasOffline = !isUserOnlineExcluding(userId, socket);
    if (wasOffline) {
      await setPresenceInMemory(userId, "ONLINE");
    }

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "typing") {
        void handleTyping(userId, msg);
      }
    });

    socket.on("close", async () => {
      const set = connections.get(userId);
      set?.delete(socket);
      if (set && set.size === 0) {
        connections.delete(userId);
        await setPresenceInMemory(userId, "OFFLINE");
      }
    });
  });

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
