import { useEffect, useState } from "react";
import { getHomeServer } from "../api/client";
import { fetchServerInfo } from "../api/discovery";
import { setLinkPreviewsShown, useLinkPreviewsShown } from "../lib/linkPreviews";

/**
 * Settings -> Link previews: show or hide the small cards under messages that link to a page. Kept on this device. Only offered where
 * the server makes previews (its discovery document says so): elsewhere there is nothing to show or hide.
 */
export default function LinkPreviewsSection() {
  const shown = useLinkPreviewsShown();
  const [offered, setOffered] = useState(false);

  useEffect(() => {
    const origin = getHomeServer()?.origin;
    if (!origin) return;
    let current = true;
    fetchServerInfo(origin)
      .then((info) => current && setOffered(info.linkPreviewsEnabled === true))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  if (!offered) return null;
  return (
    <>
      <h3>Link previews</h3>
      <p className="hint">
        This server reads the pages that messages link to and shows a small card under the message (the page&apos;s title, a short description
        and its site). Reading them is done by the server, so the site never sees your address, and the cards are plain text: nothing is
        loaded from the linked site when you read a message.
      </p>
      <label className="remember-option">
        <input type="checkbox" checked={shown} onChange={(e) => setLinkPreviewsShown(e.target.checked)} />
        Show link previews in messages (on this device)
      </label>
    </>
  );
}
