import { useState } from "react";
import type { Emoticon } from "../api";
import { mediaUrl } from "../api";

export default function EmoticonPicker({ emoticons, onPick }: { emoticons: Emoticon[]; onPick: (trigger: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="btn-secondary" style={{ borderRadius: 6, padding: "8px 12px" }} onClick={() => setOpen((o) => !o)}>
        😊
      </button>
      {open && (
        <div
          className="sidebar"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            width: 260,
            maxHeight: 260,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 10,
            zIndex: 20,
          }}
        >
          {emoticons.length === 0 ? (
            <div className="hint">No emoticons yet. Create one from the Emoticons tab.</div>
          ) : (
            <div className="emoji-grid">
              {emoticons.map((e) => (
                <div
                  key={e.id}
                  className="emoji-tile"
                  title={e.trigger}
                  onClick={() => {
                    onPick(e.trigger);
                    setOpen(false);
                  }}
                >
                  <img src={mediaUrl(e.imageUrl)} alt={e.name} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
