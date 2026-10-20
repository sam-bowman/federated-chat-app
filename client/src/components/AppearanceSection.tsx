import { useId, useMemo, useState } from "react";
import {
  DEFAULT_FONT_STACK,
  FONT_CHOICES,
  FONT_LABELS,
  SCALE_STEPS,
  autoScalePercent,
  fontHasLigatures,
  fontStack,
  isDesktopApp,
  sanitizeFontName,
  useAppearance,
  type FontChoice,
} from "../lib/appearance";
import { drawsLigatures } from "../lib/fontLigatures";
import Button from "./Button";

// A line with the things a font choice changes: letters that look alike, digits, and the symbols that become ligatures.
const SAMPLE = "The quick brown fox jumps over the lazy dog. 0123456789 Il1 O0 -> => != <= >= ==";

/**
 * Settings -> Appearance: how big the interface is and which font it is set in. Both apply at once (the page you are
 * looking at is the preview, and the sample line shows the font) and are remembered on this device only. "Auto" size
 * picks a size from the screen, which is what makes a 4K monitor at 100% system scaling usable without changing
 * anything. The fonts are included with the app: nothing is fetched from another host.
 */
/**
 * The font licences. In a browser they are a file next to the page. In the desktop app a link opens in the person's own
 * browser, which cannot reach the app's address, so it points at the same file in the project's repository.
 */
export const FONT_LICENCES_PATH = "/THIRD-PARTY-FONTS.txt";
export const FONT_LICENCES_URL = "https://github.com/sam-bowman/federated-chat-app/blob/master/client/public/THIRD-PARTY-FONTS.txt";

export default function AppearanceSection() {
  const [appearance, setAppearance] = useAppearance();
  const sizeLabelId = useId();
  const fontId = useId();
  const customId = useId();
  const autoPercent = autoScalePercent(window.screen.width);

  // What is typed in the custom font box, kept apart from what is stored so that a half-typed or invalid name can be shown
  // (and explained) without ever being applied.
  const [customDraft, setCustomDraft] = useState(appearance.customFont);
  const draftIsValid = sanitizeFontName(customDraft) !== null;
  const showCustomError = appearance.font === "custom" && customDraft.trim() !== "" && !draftIsValid;

  const stack = fontStack(appearance);
  const usingFont = appearance.font !== "default";
  // The bundled coding fonts are known to have ligatures (and IBM Plex Mono to have none). A system monospace or a font
  // typed in depends on what is installed, so ask the browser, rather than offer a checkbox that could never change
  // anything. `null`: it cannot tell, so the option is offered.
  const ligatureProbe = useMemo(
    () => (stack !== null && (appearance.font === "mono-system" || appearance.font === "custom") ? drawsLigatures(stack) : null),
    [stack, appearance.font]
  );
  const fontHasNoLigatures = appearance.font === "ibm-plex-mono" || ligatureProbe === false;

  function chooseFont(font: FontChoice) {
    // Choosing Custom starts from whatever name is already typed (it only applies once the name is usable).
    setAppearance({ ...appearance, font, customFont: font === "custom" ? (sanitizeFontName(customDraft) ?? "") : appearance.customFont });
  }

  function typeCustom(value: string) {
    setCustomDraft(value);
    const name = sanitizeFontName(value);
    if (name !== null) setAppearance({ ...appearance, font: "custom", customFont: name });
    else if (appearance.font === "custom") setAppearance({ ...appearance, customFont: "" });
  }

  return (
    <>
      <h3>Appearance</h3>

      <div className="hint" id={sizeLabelId}>
        Interface size
      </div>
      <div role="group" aria-labelledby={sizeLabelId} className="appearance-scale">
        <Button
          size="sm"
          variant={appearance.scale === "auto" ? "primary" : "secondary"}
          aria-pressed={appearance.scale === "auto"}
          onClick={() => setAppearance({ ...appearance, scale: "auto" })}
        >
          Auto ({autoPercent}%)
        </Button>
        {SCALE_STEPS.map((percent) => (
          <Button
            key={percent}
            size="sm"
            variant={appearance.scale === percent ? "primary" : "secondary"}
            aria-pressed={appearance.scale === percent}
            onClick={() => setAppearance({ ...appearance, scale: percent })}
          >
            {percent}%
          </Button>
        ))}
      </div>
      <p className="hint">
        Changes the size of everything at once, on this device only. Auto picks a size from this screen.
        {isDesktopApp() && " Ctrl and + or - also change it, and Ctrl and 0 goes back to Auto."}
      </p>

      <div className="appearance-font">
        <label className="hint" htmlFor={fontId}>
          Font
        </label>
        <select id={fontId} value={appearance.font} onChange={(e) => chooseFont(e.target.value as FontChoice)}>
          {FONT_CHOICES.map((font) => (
            <option key={font} value={font}>
              {FONT_LABELS[font]}
            </option>
          ))}
        </select>

        {appearance.font === "custom" && (
          <>
            <label className="hint" htmlFor={customId}>
              Name of the font
            </label>
            <input
              id={customId}
              value={customDraft}
              onChange={(e) => typeCustom(e.target.value)}
              maxLength={64}
              placeholder="for example Cascadia Code"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={showCustomError}
              aria-describedby={`${customId}-hint`}
            />
            <div className="hint" id={`${customId}-hint`}>
              Any font installed on this device. If it is not found, the usual font is used.
            </div>
            {showCustomError && (
              <div className="error-text" role="alert">
                A font name can only have letters, numbers, spaces and . _ -
              </div>
            )}
          </>
        )}

        {usingFont && (
          <label className="appearance-check">
            <input
              type="checkbox"
              checked={appearance.fontScope === "messages"}
              onChange={(e) => setAppearance({ ...appearance, fontScope: e.target.checked ? "messages" : "ui" })}
            />
            Use this font for messages only
          </label>
        )}

        {usingFont && fontHasNoLigatures && (
          <p className="hint">This font does not draw ligatures, so there is nothing to turn on.</p>
        )}

        {usingFont && fontHasLigatures(appearance.font) && !fontHasNoLigatures && (
          <label className="appearance-check">
            <input
              type="checkbox"
              checked={appearance.ligatures}
              onChange={(e) => setAppearance({ ...appearance, ligatures: e.target.checked })}
            />
            Ligatures (draw -&gt; and != as one symbol, in fonts that have them)
          </label>
        )}

        <div className="hint">Preview</div>
        {/* The chosen font itself, whichever of the whole UI or messages it applies to, so the choice can be judged. */}
        <p
          className="font-preview"
          style={{ fontFamily: stack ?? DEFAULT_FONT_STACK, fontVariantLigatures: usingFont && !appearance.ligatures ? "none" : "normal" }}
        >
          {SAMPLE}
        </p>
        <p className="hint">
          {usingFont
            ? "JetBrains Mono, IBM Plex Mono and Fira Code come with the app; nothing is fetched from another site. "
            : "The usual font. Choose another to see it here. "}
          <a href={isDesktopApp() ? FONT_LICENCES_URL : FONT_LICENCES_PATH} target="_blank" rel="noreferrer">
            Font licences
          </a>
        </p>
      </div>
    </>
  );
}
