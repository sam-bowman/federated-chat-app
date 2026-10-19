import { useId } from "react";

/** One choice for a place: follow the level above, or on, or off. `null` is "follow". */
export default function NotificationChoice({
  label,
  value,
  inherited,
  onChange,
}: {
  label: string;
  value: boolean | null;
  /** What following the level above means right now, so "Default" can say it. */
  inherited: boolean;
  onChange: (value: boolean | null) => void;
}) {
  const id = useId();
  return (
    <div className="notification-choice">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value === null ? "default" : value ? "on" : "off"}
        onChange={(e) => onChange(e.target.value === "default" ? null : e.target.value === "on")}
      >
        <option value="default">{`Default (${inherited ? "on" : "off"})`}</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </div>
  );
}
