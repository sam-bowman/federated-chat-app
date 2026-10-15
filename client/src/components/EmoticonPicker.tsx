import { useState } from "react";
import type { Emoticon } from "../api";
import { mediaUrl } from "../api";
import Button from "./Button";

export default function EmoticonPicker({ emoticons, onPick }: { emoticons: Emoticon[]; onPick: (trigger: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <Button type="button" onClick={() => setOpen((o) => !o)} variant="secondary">
        😊
      </Button>
      {open && (
        <div
          className="sidebar"
          style={{
            position: "absolute",
            bottom: "calc(100% + 0.5rem)",
            right: 0,
            width: "16.25rem",
            maxHeight: "16.25rem",
            border: "1px solid var(--border)",
            borderRadius: "0.5rem",
            padding: "0.625rem",
            zIndex: 20,
          }}
        >
          {emoticons.length === 0 ? (
            <div className="hint">No emoticons yet. Create one from the Emoticons tab.</div>
          ) : (
            <div className="emoji-grid">
              {emoticons.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="emoji-tile"
                  title={e.trigger}
                  onClick={() => {
                    onPick(e.trigger);
                    setOpen(false);
                  }}
                >
                  <img src={mediaUrl(e.imageUrl)} alt={e.name} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
