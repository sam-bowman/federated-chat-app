import { useRef, useState } from "react";
import * as api from "../api";
import type { Emoticon } from "../api";
import { useWs } from "../context/WsContext";
import EmoticonPicker from "./EmoticonPicker";

interface Props {
  placeholder: string;
  emoticons: Emoticon[];
  typingTarget: { conversationId?: string; channelId?: string };
  onSend: (content: string, attachments?: { url: string; filename: string; contentType: string; size: number }[]) => Promise<void>;
}

export default function Composer({ placeholder, emoticons, typingTarget, onSend }: Props) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ url: string; filename: string; contentType: string; size: number } | null>(
    null
  );
  const { sendTyping } = useWs();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    const now = Date.now();
    if (now - lastTypingSent.current > 2000) {
      sendTyping(typingTarget);
      lastTypingSent.current = now;
    }
  }

  // The hidden file <input> sitting in the same <form> stops the text input's
  // native implicit-submit-on-Enter from firing, so submit explicitly here.
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const uploaded = await api.uploadFile(file);
    setPendingFile(uploaded);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() && !pendingFile) return;
    setSending(true);
    try {
      await onSend(value.trim() || "(attachment)", pendingFile ? [pendingFile] : undefined);
      setValue("");
      setPendingFile(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit} style={{ flexDirection: "column", gap: 6 }}>
      {pendingFile && (
        <div className="hint">
          📎 {pendingFile.filename}{" "}
          <button type="button" className="btn-secondary" style={{ padding: "0 6px", borderRadius: 4 }} onClick={() => setPendingFile(null)}>
            ✕
          </button>
        </div>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <input type="file" ref={fileInputRef} style={{ display: "none" }} onChange={handleFilePick} />
        <button type="button" className="btn-secondary" style={{ borderRadius: 6, padding: "8px 12px" }} onClick={() => fileInputRef.current?.click()}>
          📎
        </button>
        <input value={value} onChange={handleChange} onKeyDown={handleKeyDown} placeholder={placeholder} />
        <EmoticonPicker emoticons={emoticons} onPick={(trigger) => setValue((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}${trigger} `)} />
        <button className="btn" type="submit" disabled={sending || (!value.trim() && !pendingFile)}>
          Send
        </button>
      </div>
    </form>
  );
}
