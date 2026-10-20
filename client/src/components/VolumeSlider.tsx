import { useId } from "react";
import { DEFAULT_PERCENT, MAX_PERCENT, MIN_PERCENT } from "../lib/voiceAudio";
import Button from "./Button";

/**
 * A volume from 0% to 200% (100% is as it comes, more is a boost): a slider the keyboard can move, its value in words, and a button
 * that puts it back to 100%.
 */
export default function VolumeSlider({
  label,
  value,
  onChange,
  step = 5,
}: {
  label: string;
  value: number;
  onChange: (percent: number) => void;
  step?: number;
}) {
  const id = useId();
  return (
    <div className="volume-slider">
      <label htmlFor={id}>{label}</label>
      <div className="volume-slider-row">
        <input
          id={id}
          type="range"
          min={MIN_PERCENT}
          max={MAX_PERCENT}
          step={step}
          value={value}
          aria-valuetext={`${value}%`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id} className="volume-slider-value">
          {value}%
        </output>
        <Button variant="secondary" size="sm" disabled={value === DEFAULT_PERCENT} aria-label={`Reset ${label} to ${DEFAULT_PERCENT}%`} onClick={() => onChange(DEFAULT_PERCENT)}>
          Reset
        </Button>
      </div>
    </div>
  );
}
