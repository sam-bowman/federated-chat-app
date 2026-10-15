import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
export type ButtonSize = "md" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary is the default; danger is for actions that destroy something. */
  variant?: ButtonVariant;
  /** `sm` is the compact size, for actions in a row of a list. */
  size?: ButtonSize;
  /** Waiting on the server: shows a spinner, disables the button, and tells assistive tech. */
  busy?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "",
  secondary: "btn-secondary",
  danger: "btn-danger",
  ghost: "btn-ghost",
  link: "btn-link",
};

/**
 * The app's one button. Every variant and size is defined once in index.css, so a new button
 * can't drift from the rest; don't put sizing or colours in `style` (a test fails on that, and
 * on a raw <button> that uses these classes). `style` is still fine for layout (margin,
 * alignSelf, ...). Unlike a raw <button>, `type` defaults to "button", so a button inside a
 * form does not submit it by accident: pass `type="submit"` for the one that should.
 */
export default function Button({
  variant = "primary",
  size = "md",
  busy = false,
  type = "button",
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = ["btn", VARIANT_CLASS[variant], size === "sm" ? "btn-sm" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}
