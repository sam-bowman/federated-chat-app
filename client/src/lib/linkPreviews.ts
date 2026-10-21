import { useSyncExternalStore } from "react";

// Link previews (#197): the small card under a message with what its link's page says. Whether to SHOW them is a choice made on this
// device (the server decides whether it makes them at all, and says so in its discovery document). Off means no card is drawn, and
// nothing about the page is loaded here either way: the card is text, so reading a message never contacts the linked site.

const KEY = "chat.linkPreviews";
const CHANGED = "chat:link-previews-changed";

/** Whether previews are shown on this device: yes, unless the person chose not to. */
export function linkPreviewsShown(): boolean {
  try {
    return localStorage.getItem(KEY) !== "hide";
  } catch {
    return true;
  }
}

export function setLinkPreviewsShown(shown: boolean): void {
  try {
    if (shown) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "hide");
  } catch {
    // Not remembered, but the choice still holds until the page is closed.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** True while previews are to be shown; changes as soon as the setting does. */
export function useLinkPreviewsShown(): boolean {
  return useSyncExternalStore(subscribe, linkPreviewsShown, () => true);
}

/**
 * The address a preview links to, or null if it is not a plain http(s) address. The server has checked it already, and a server the
 * message came from has been checked by this one; this is the last line before it becomes a link in the page, and the only one that
 * does not depend on anyone else having done their part.
 */
export function previewHref(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** The site's own name from its address, `www.` taken off: shown beside whatever the page calls itself, which it can choose freely. */
export function previewHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./iu, "");
  } catch {
    return "";
  }
}
