import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import Button from "./Button";
import ColourPickerModal from "./ColourPickerModal";

interface Props {
  /** Names the field for assistive technology, for example "Role colour". */
  label: string;
  /** "#rrggbb", or null for no colour. */
  value: string | null;
  onChange: (colour: string | null) => void;
  /** The word the picker's preview shows, for example the role's name. */
  previewText?: string;
  allowNone?: boolean;
  /** What "no colour" is called here, for example "Default colour". */
  noneLabel?: string;
}

/**
 * A swatch showing the current colour; pressing it opens the colour picker. The picker's result
 * only reaches `onChange` when it is applied, so cancelling leaves the colour as it was.
 */
export default function ColourField({
  label,
  value,
  onChange,
  previewText,
  allowNone = true,
  noneLabel = "No colour",
}: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    // Modal gives focus back to what had it, but a button does not always take focus when pressed
    // (Safari), so say where it goes.
    button.current?.focus();
  }

  return (
    <>
      <Button
        ref={button}
        variant="secondary"
        aria-haspopup="dialog"
        aria-label={`${label}: ${value ?? noneLabel.toLowerCase()}. Change`}
        onClick={() => setOpen(true)}
      >
        <span
          className={`colour-dot${value ? "" : " colour-dot-none"}`}
          style={value ? ({ "--swatch": value } as React.CSSProperties) : undefined}
        />
        {value ?? noneLabel}
      </Button>
      {/* In a portal so the picker's own form is not inside the form this field sits in. */}
      {open &&
        createPortal(
          <ColourPickerModal
            value={value}
            onApply={onChange}
            onClose={close}
            previewText={previewText}
            allowNone={allowNone}
            noneLabel={noneLabel}
          />,
          document.body
        )}
    </>
  );
}
