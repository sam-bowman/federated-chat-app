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

// The picture on a card (#244) is a second choice on this device. It is a copy on a server of the federation, so the linked site never
// sees you, but your browser does ask that server for it: this server for a message from here, the sender's server for one from elsewhere.
// Off means a card is drawn without its picture (and a link that is only a picture is not drawn at all).
const PICTURES_KEY = "chat.linkPreviewPictures";

/** Whether pictures on previews are shown on this device: yes, unless the person chose not to. */
export function linkPreviewPicturesShown(): boolean {
  try {
    return localStorage.getItem(PICTURES_KEY) !== "hide";
  } catch {
    return true;
  }
}

export function setLinkPreviewPicturesShown(shown: boolean): void {
  try {
    if (shown) localStorage.removeItem(PICTURES_KEY);
    else localStorage.setItem(PICTURES_KEY, "hide");
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

/** True while pictures on previews are to be shown; changes as soon as the setting does. */
export function useLinkPreviewPicturesShown(): boolean {
  return useSyncExternalStore(subscribe, linkPreviewPicturesShown, () => true);
}

/** The largest side a picture may have: the server holds the copies to this, and a card leaves room for what it says, so it is checked again here. */
const MAX_PICTURE_SIDE = 4096;

/**
 * A preview's picture, or null if it cannot be drawn safely: a plain http(s) address with no name and password, and a sane size. The server has
 * checked it, and so has any server it came from; like previewHref this is the last line before it becomes an `<img src>`.
 */
export function previewPicture(image: unknown): { src: string; width: number; height: number } | null {
  if (!image || typeof image !== "object") return null;
  const { url, width, height } = image as { url?: unknown; width?: unknown; height?: unknown };
  const src = previewHref(url);
  if (!src || typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_PICTURE_SIDE || height > MAX_PICTURE_SIDE) return null;
  return { src, width, height };
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
