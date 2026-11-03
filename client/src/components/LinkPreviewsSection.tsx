import { useEffect, useState } from "react";
import { getHomeServer } from "../api/client";
import { fetchServerInfo } from "../api/discovery";
import { setLinkPreviewPicturesShown, setLinkPreviewsShown, useLinkPreviewPicturesShown, useLinkPreviewsShown } from "../lib/linkPreviews";

/**
 * Settings -> Link previews: show or hide the small cards under messages that link to a page, and their pictures. Kept on this device. Only
 * offered where the server makes previews (its discovery document says so): elsewhere there is nothing to show or hide.
 */
export default function LinkPreviewsSection() {
  const shown = useLinkPreviewsShown();
  const picturesShown = useLinkPreviewPicturesShown();
  const [offered, setOffered] = useState(false);
  const [withPictures, setWithPictures] = useState(false);

  useEffect(() => {
    const origin = getHomeServer()?.origin;
    if (!origin) return;
    let current = true;
    fetchServerInfo(origin)
      .then((info) => {
        if (!current) return;
        setOffered(info.linkPreviewsEnabled === true);
        setWithPictures(info.linkPreviewImagesEnabled === true);
      })
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
        and its site). Reading them is done by the server, so the site never sees your address, and nothing is loaded from the linked site
        when you read a message.
        {withPictures &&
          " This server also keeps a copy of the page's picture. Your browser loads that copy from a server of this network (this one, or the one the message came from), never from the linked site."}
      </p>
      <label className="remember-option">
        <input type="checkbox" checked={shown} onChange={(e) => setLinkPreviewsShown(e.target.checked)} />
        Show link previews in messages (on this device)
      </label>
      {withPictures && (
        <label className="remember-option">
          <input type="checkbox" checked={picturesShown} disabled={!shown} onChange={(e) => setLinkPreviewPicturesShown(e.target.checked)} />
          Show the pictures on link previews (on this device)
        </label>
      )}
    </>
  );
}
