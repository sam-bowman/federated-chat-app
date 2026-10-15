import { statusLabel } from "../lib/presence";

/**
 * The coloured dot for someone's status. It says the status in words to assistive technology and as a
 * tooltip; where the words are already written beside it, pass `decorative` so they are not read twice.
 */
export default function PresenceDot({ status, decorative = false }: { status: string; decorative?: boolean }) {
  const label = statusLabel(status);
  if (decorative) return <span className={`presence-dot ${status}`} aria-hidden="true" />;
  return <span className={`presence-dot ${status}`} role="img" aria-label={label} title={label} />;
}
