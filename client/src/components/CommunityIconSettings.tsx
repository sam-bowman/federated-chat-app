import { useState } from "react";
import * as api from "../api";
import type { Community } from "../api";
import { useAppData } from "../context/AppDataContext";
import { defaultIconText, normaliseIconText } from "../lib/communityIcon";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import ColourField from "./ColourField";
import { TileFace, tileProps } from "./CommunityTile";
import FileButton from "./FileButton";

type Working = "picture" | "remove" | "letters" | null;

/**
 * Settings -> General -> Icon: what the community's tile on the rail looks like. A picture (uploaded
 * and applied at once, like an avatar), or letters on a colour for when there is no picture. The
 * previews show the tile as the rail will draw it, normal and selected, with what is typed so far.
 * Not a form: the picture applies as soon as it is chosen and the letters have their own button.
 */
export default function CommunityIconSettings({ community }: { community: Community }) {
  const { refreshCommunities } = useAppData();
  const [text, setText] = useState(community.iconText ?? "");
  const [colour, setColour] = useState<string | null>(community.iconColor);
  const [working, setWorking] = useState<Working>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const typed = text.trim();
  const normalised = typed === "" ? null : normaliseIconText(typed);
  const textInvalid = typed !== "" && normalised === null;
  const changed = normalised !== community.iconText || colour !== community.iconColor;

  // The previews draw what is on screen, not what is saved yet (an invalid text keeps the saved one).
  const draft = {
    ...community,
    iconText: textInvalid ? community.iconText : normalised,
    iconColor: colour,
  };

  async function run(kind: Exclude<Working, null>, work: () => Promise<void>, failure: string) {
    setWorking(kind);
    setError(null);
    setSaved(false);
    try {
      await work();
      await refreshCommunities();
      if (kind === "letters") {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError(failure);
    } finally {
      setWorking(null);
    }
  }

  function choosePicture(file: File | null) {
    if (!file) return;
    // The upload route takes other kinds of file too (documents, video): only a picture is a tile.
    if (!file.type.startsWith("image/")) {
      setError("That isn't a picture. Choose a PNG, JPEG, GIF or WebP image.");
      return;
    }
    void run(
      "picture",
      async () => {
        const uploaded = await api.uploadFile(file);
        await api.updateCommunity(community.id, { iconUrl: uploaded.url });
      },
      "Couldn't use that picture. It may be too large; try a smaller one."
    );
  }

  return (
    <section className="icon-settings" aria-labelledby="icon-settings-heading">
      <div id="icon-settings-heading" className="hint">
        Icon
      </div>

      <div className="tile-previews" aria-label="Preview">
        <div className="tile-preview">
          <div className={`rail-item rail-community${tileProps(draft).className}`} style={tileProps(draft).style}>
            <TileFace community={draft} />
          </div>
          <span className="hint">On the rail</span>
        </div>
        <div className="tile-preview">
          <div className={`rail-item rail-community active${tileProps(draft).className}`} style={tileProps(draft).style}>
            <TileFace community={draft} />
          </div>
          <span className="hint">Selected</span>
        </div>
      </div>

      <div className="icon-settings-row">
        <FileButton
          file={null}
          onChange={choosePicture}
          accept="image/*"
          label={community.iconUrl ? "Change picture" : "Upload a picture"}
          showName={false}
          disabled={working !== null}
        />
        {community.iconUrl && (
          <Button
            variant="secondary"
            size="sm"
            busy={working === "remove"}
            disabled={working !== null}
            onClick={() =>
              void run("remove", () => api.updateCommunity(community.id, { iconUrl: null }).then(() => {}), "Couldn't remove the picture.")
            }
          >
            Remove picture
          </Button>
        )}
        {working === "picture" && <span className="hint">Uploading…</span>}
      </div>

      <div className="hint">
        {community.iconUrl
          ? "The picture is shown instead of the letters. Remove it to use letters and a colour."
          : "Without a picture the tile shows letters on a colour. Both are optional."}
      </div>

      <div className="icon-settings-row">
        <label className="hint" htmlFor="icon-letters">
          Letters
        </label>
        <input
          {...noAutofill}
          id="icon-letters"
          name="icon-letters"
          value={text}
          placeholder={defaultIconText(community.name)}
          maxLength={12}
          aria-invalid={textInvalid}
          aria-describedby="icon-letters-help"
          style={{ width: "7rem" }}
          onChange={(e) => setText(e.target.value)}
        />
        <ColourField
          label="Tile colour"
          value={colour}
          onChange={setColour}
          previewText={normalised ?? defaultIconText(community.name)}
          noneLabel="Default colour"
        />
      </div>
      <div id="icon-letters-help" className={textInvalid ? "error-text" : "hint"}>
        {textInvalid ? "Use 1 to 3 characters." : "1 to 3 characters; empty uses the first two letters of the name."}
      </div>

      <div className="icon-settings-row">
        <Button
          busy={working === "letters"}
          disabled={!changed || textInvalid || working !== null}
          onClick={() =>
            void run(
              "letters",
              () => api.updateCommunity(community.id, { iconText: normalised, iconColor: colour }).then(() => {}),
              "Couldn't save the icon."
            )
          }
        >
          Save icon
        </Button>
        {saved && (
          <span className="hint" role="status">
            Saved
          </span>
        )}
      </div>

      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
