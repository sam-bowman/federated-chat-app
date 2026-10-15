import { useEffect, useRef } from "react";
import Button from "./Button";

interface FileButtonProps {
  /** The chosen file, or null for none. Set it back to null to clear the chooser. */
  file: File | null;
  onChange: (file: File | null) => void;
  /** Passed to the native input, for example "image/*". */
  accept?: string;
  label?: string;
  disabled?: boolean;
}

/**
 * Choosing a file in the app's own style: a button, and the chosen name beside it, in place of
 * the browser's native "Browse..." control (which looks different in every browser and nothing
 * like the rest of the app). The real <input type="file"> stays in the page, hidden, so the
 * browser's own file dialog, drag and drop to a form, and assistive technology still work.
 */
export default function FileButton({ file, onChange, accept, label = "Choose file", disabled }: FileButtonProps) {
  const input = useRef<HTMLInputElement>(null);

  // A hidden input remembers its own file; clearing it from outside has to reach it too, or the
  // same file could not be chosen again after an upload.
  useEffect(() => {
    if (!file && input.current) input.current.value = "";
  }, [file]);

  return (
    <span className="file-chooser">
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        tabIndex={-1}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </Button>
      <span className="file-chooser-name" title={file?.name}>
        {file ? file.name : "No file chosen"}
      </span>
    </span>
  );
}
