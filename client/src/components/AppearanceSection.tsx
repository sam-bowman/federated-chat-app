import { useId } from "react";
import { SCALE_STEPS, autoScalePercent, isDesktopApp, useAppearance } from "../lib/appearance";
import Button from "./Button";

/**
 * Settings -> Appearance: how big the whole interface is. It applies at once (the page you are looking at is the
 * preview) and is remembered on this device only. "Auto" picks a size from the screen, which is what makes a 4K
 * monitor at 100% system scaling usable without changing anything.
 */
export default function AppearanceSection() {
  const [appearance, setAppearance] = useAppearance();
  const labelId = useId();
  const autoPercent = autoScalePercent(window.screen.width);

  return (
    <>
      <h3>Appearance</h3>
      <div className="hint" id={labelId}>
        Interface size
      </div>
      <div role="group" aria-labelledby={labelId} className="appearance-scale">
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
    </>
  );
}
