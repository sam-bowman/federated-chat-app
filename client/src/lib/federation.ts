import { useEffect, useSyncExternalStore } from "react";
import { getHomeServer } from "../api/client";
import { fetchServerInfo } from "../api/discovery";
import { domainOf } from "./permissions";

// Whether this client's home server talks to other servers at all. A private server (FEDERATION_ENABLED=false) says so in its
// discovery document, and the client then stops offering what could only fail: adding someone on another server, joining a
// community on one, messaging a friend there. The server refuses all of it anyway (403 federation_disabled); this is so a
// person is told up front, plainly, instead of after trying.
//
// Learned from the discovery document, once per load and again when the window regains focus (at most once a minute), so a
// server that was restarted with the setting changed is noticed without a reload. Until it is known, and if the server cannot be
// asked, federation is assumed on: a server that cannot be reached is not claimed to be private.

let enabled = true;
let loadedFor: string | null = null;
let loadedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const REFRESH_MS = 60_000;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFederationEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  listeners.forEach((listener) => listener());
}

/** Forgets what was learned (for tests, and for switching to another server). */
export function resetFederationState(): void {
  loadedFor = null;
  loadedAt = 0;
  inFlight = null;
  setFederationEnabled(true);
}

// One request at a time however many components ask at once: everything on a page that offers something remote asks together.
function refresh(origin: string): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const info = await fetchServerInfo(origin);
      setFederationEnabled(info.federationEnabled !== false);
    } catch {
      // Not known: leave it as it was.
    } finally {
      // Counted as asked even if it failed, so a server that cannot be reached is not asked again by every component and every
      // focus; the next try is a minute on.
      loadedFor = origin;
      loadedAt = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}

/** True unless the home server has said it is private. */
export function useFederationEnabled(): boolean {
  const value = useSyncExternalStore(subscribe, () => enabled);
  useEffect(() => {
    const check = () => {
      const origin = getHomeServer()?.origin;
      if (!origin) return;
      if (loadedFor !== origin || Date.now() - loadedAt > REFRESH_MS) void refresh(origin);
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  return value;
}

/**
 * Whether something typed names a person on a server other than `ownDomain`: "@user:domain" or "user:domain". A bare
 * "user" is on this server, and so is "user:<own domain>". Case does not matter in a domain.
 */
export function isRemoteIdentity(input: string, ownDomain: string): boolean {
  const match = /^@?([^:\s@]+):(\S+)$/.exec(input.trim());
  if (!match) return false;
  return match[2].toLowerCase() !== ownDomain.toLowerCase();
}

/** Whether a person (by identity, "@user:domain") is on another server than the viewer's. */
export function isOnAnotherServer(identity: string, viewerIdentity: string): boolean {
  return domainOf(identity) !== domainOf(viewerIdentity);
}

/** What the person is told when they try to reach another server from a private one. */
export const PRIVATE_SERVER_MESSAGE = "This server doesn't connect to other servers, so this can only be done with people on it.";
