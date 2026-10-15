import { useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { noAutofill } from "../lib/noAutofill";
import { contrastRatio } from "../lib/contrast";
import {
  COLOUR_PRESETS,
  SIDEBAR_BACKGROUND,
  hexToHsv,
  hsvToHex,
  parseHexInput,
  squareToSv,
  type Hsv,
} from "../lib/colour";
import Button from "./Button";
import Modal from "./Modal";

interface Props {
  /** The colour to start from, or null for none. */
  value: string | null;
  /** Called with "#rrggbb", or null for "no colour", when the person applies their choice. */
  onApply: (colour: string | null) => void;
  onClose: () => void;
  /** Whether "No colour" is offered: yes for a role (its colour is optional). */
  allowNone?: boolean;
  /** What "no colour" is called, for example "Default colour". */
  noneLabel?: string;
  /** The word shown in the preview chip, for example the role's name. */
  previewText?: string;
  title?: string;
}

// Below this, text in the colour is hard to read on the sidebar (WCAG's minimum for large text and
// interface parts); a role's colour is shown as a dot and a stripe, so it is a warning, not a block.
const MIN_CONTRAST = 3;
const STARTING_COLOUR = "#99aab5";

/**
 * Choosing a colour in the app's own style, instead of the browser's colour popup (which looks
 * different in every browser and system): presets first, since most people want one of those, then
 * a custom colour by hue, saturation and brightness sliders (and a square you can drag), or typed
 * as hex. The result is always "#rrggbb" or "no colour", the only shapes the server accepts.
 *
 * Esc or Cancel throws the choice away; Apply (or Enter) keeps it. Focus goes back to whatever
 * opened it (Modal does that). Everything works from the keyboard: the presets are a radio group
 * with arrow keys, and the square is only a pointer shortcut for the two sliders.
 */
export default function ColourPickerModal({
  value,
  onApply,
  onClose,
  allowNone = true,
  noneLabel = "No colour",
  previewText = "Role",
  title = "Choose a colour",
}: Props) {
  const [colour, setColour] = useState<string | null>(value);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value ?? STARTING_COLOUR));
  const [hexText, setHexText] = useState(value ?? "");
  const hexInvalid = hexText.trim() !== "" && parseHexInput(hexText) === null;

  function choose(hex: string) {
    setColour(hex);
    setHsv(hexToHsv(hex));
    setHexText(hex);
  }

  function chooseNone() {
    setColour(null);
    setHexText("");
  }

  function setPart(next: Hsv) {
    setHsv(next);
    const hex = hsvToHex(next);
    setColour(hex);
    setHexText(hex);
  }

  function onHexChange(text: string) {
    setHexText(text);
    const parsed = parseHexInput(text);
    if (parsed) {
      setColour(parsed);
      setHsv(hexToHsv(parsed));
    }
  }

  function apply(event: FormEvent) {
    // This form sits inside the role editor's form in the React tree, and a React submit bubbles up it.
    event.preventDefault();
    event.stopPropagation();
    if (hexInvalid) return;
    onApply(colour);
    onClose();
  }

  // Enter confirms from anywhere except a button (where it presses that button). A text field
  // already submits the form on its own; sliders do not, so they are handled here.
  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    const target = event.target as HTMLElement;
    if (event.key === "Enter" && target.tagName === "INPUT" && (target as HTMLInputElement).type === "range") {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  // The square is a shortcut for the saturation and brightness sliders, for a pointer only.
  const square = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  function pickFromSquare(event: PointerEvent<HTMLDivElement>) {
    const box = square.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const { s, v } = squareToSv((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    setPart({ ...hsv, s, v });
  }

  const options: { key: string; name: string; hex: string | null }[] = [
    ...(allowNone ? [{ key: "none", name: noneLabel, hex: null }] : []),
    ...COLOUR_PRESETS.map((p) => ({ key: p.hex, name: p.name, hex: p.hex })),
  ];
  const checkedIndex = options.findIndex((o) => o.hex === colour);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  function onRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (option.hex === null) chooseNone();
    else choose(option.hex);
    radios.current[next]?.focus();
  }

  const lowContrast = colour !== null && contrastRatio(colour, SIDEBAR_BACKGROUND) < MIN_CONTRAST;

  return (
    <Modal title={title} onClose={onClose} width={440}>
      <form onSubmit={apply} onKeyDown={onFormKeyDown} className="colour-picker">
        <div role="radiogroup" aria-label="Preset colours" className="swatch-grid">
          {options.map((option, index) => {
            const checked = index === checkedIndex;
            return (
              <button
                key={option.key}
                ref={(element) => {
                  radios.current[index] = element;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={option.hex ? `${option.name} (${option.hex})` : option.name}
                title={option.name}
                tabIndex={checked || (checkedIndex === -1 && index === 0) ? 0 : -1}
                className={`swatch${option.hex === null ? " swatch-none" : ""}`}
                style={option.hex ? ({ "--swatch": option.hex } as React.CSSProperties) : undefined}
                onClick={() => (option.hex === null ? chooseNone() : choose(option.hex))}
                onKeyDown={(event) => onRadioKeyDown(event, index)}
              >
                {option.hex === null ? "∅" : ""}
              </button>
            );
          })}
        </div>

        <div className="hint">Custom</div>
        <div
          ref={square}
          aria-hidden="true"
          className="colour-square"
          style={{ "--hue": hsv.h } as React.CSSProperties}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            pickFromSquare(event);
          }}
          onPointerMove={(event) => {
            if (dragging.current) pickFromSquare(event);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          <div className="colour-square-thumb" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }} />
        </div>

        <label className="slider-row">
          <span>Hue</span>
          <input
            type="range"
            className="hue-slider"
            min={0}
            max={360}
            value={hsv.h}
            aria-valuetext={`${hsv.h} degrees`}
            onChange={(e) => setPart({ ...hsv, h: Number(e.target.value) })}
          />
        </label>
        <label className="slider-row">
          <span>Saturation</span>
          <input
            type="range"
            min={0}
            max={100}
            value={hsv.s}
            aria-valuetext={`${hsv.s} percent`}
            onChange={(e) => setPart({ ...hsv, s: Number(e.target.value) })}
          />
        </label>
        <label className="slider-row">
          <span>Brightness</span>
          <input
            type="range"
            min={0}
            max={100}
            value={hsv.v}
            aria-valuetext={`${hsv.v} percent`}
            onChange={(e) => setPart({ ...hsv, v: Number(e.target.value) })}
          />
        </label>

        <label className="slider-row">
          <span>Hex</span>
          <input
            {...noAutofill}
            name="colour-hex"
            value={hexText}
            placeholder="#rrggbb"
            maxLength={7}
            spellCheck={false}
            aria-invalid={hexInvalid}
            aria-describedby="colour-hex-help"
            onChange={(e) => onHexChange(e.target.value)}
          />
        </label>
        <div id="colour-hex-help" className={hexInvalid ? "error-text" : "hint"}>
          {hexInvalid ? "That is not a complete colour: use six digits, like #ff8800." : "Six digits, like #ff8800."}
        </div>

        <div className="hint">Preview</div>
        <div className="colour-preview" style={{ background: SIDEBAR_BACKGROUND }}>
          <span className="colour-preview-chip">
            <span className="colour-preview-dot" style={{ background: colour ?? "var(--text-dim)" }} />
            {previewText}
          </span>
          <span className="hint">{colour ?? noneLabel}</span>
        </div>
        {lowContrast && (
          <div role="status" className="warning-text">
            This colour is hard to see on the dark sidebar. You can still use it.
          </div>
        )}

        <div style={{ display: "flex", gap: "0.625rem", justifyContent: "flex-end", marginTop: "0.25rem" }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={hexInvalid}>
            Apply
          </Button>
        </div>
      </form>
    </Modal>
  );
}
