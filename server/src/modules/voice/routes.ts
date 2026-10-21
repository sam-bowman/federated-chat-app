import express, { Router } from "express";
import { config } from "../../config.js";
import { createWebhookReceiver } from "../../lib/voiceBackend.js";
import { broadcastVoiceState, stopWatching, watchUntilActive } from "./service.js";

export const voiceRouter = Router();

// What LiveKit sends this server when something happens in a room (`webhook.urls` in its config). It is the only caller, and
// it proves it is by signing the exact body with the shared API secret, so the body is read as TEXT (LiveKit's content
// type, `application/webhook+json`, is not one the JSON parser in app.ts touches) and checked before anything is believed.
//
// Only "someone joined" and "someone left" matter: each makes this server read the room's real list from LiveKit and tell the
// community's members. Everything else (room started, tracks published...) is acknowledged and ignored.
const ROOM_CHANGES = new Set(["participant_joined", "participant_left", "participant_connection_aborted", "track_published", "track_unpublished"]);

voiceRouter.post("/webhook", express.text({ type: "application/webhook+json", limit: "100kb" }), async (req, res) => {
  if (!config.voice.enabled) return res.status(404).json({ error: "voice_not_enabled" });

  const body = typeof req.body === "string" ? req.body : "";
  let event;
  try {
    event = await createWebhookReceiver(config.voice).receive(body, req.get("Authorization") ?? undefined);
  } catch {
    // Not from our LiveKit (no or wrong signature, a body that was changed, a token for another secret).
    return res.status(401).json({ error: "invalid_signature" });
  }

  if (ROOM_CHANGES.has(event.event) && event.room?.name) {
    const room = event.room.name;
    const identity = event.participant?.identity;
    try {
      // Joined is said when LiveKit accepts the request, before the audio connection exists: the person is listed once it does.
      if (event.event === "participant_joined" && identity) watchUntilActive(room, identity);
      if ((event.event === "participant_left" || event.event === "participant_connection_aborted") && identity) stopWatching(room, identity);
      await broadcastVoiceState(room);
    } catch (err) {
      // Answered 200 anyway: LiveKit would only send the same event again, and the next change or the next list request
      // brings everyone up to date.
      console.error("[voice] telling a community about a room failed:", err);
    }
  }
  res.json({ ok: true });
});
