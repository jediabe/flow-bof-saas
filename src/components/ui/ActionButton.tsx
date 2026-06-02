import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "default" | "ghost" | "danger";

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "btn btn-primary",
  default: "btn",
  ghost:   "btn btn-ghost",
  danger:  "btn btn-danger",
};

/**
 * Styled <button> wrapping the .btn family in globals.css. Use this
 * instead of raw <button className="btn …"> so we get the same
 * focus/disabled treatment everywhere.
 */
export default function ActionButton({
  variant = "default",
  icon,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: ReactNode;
}) {
  return (
    <button className={`${VARIANT_CLASS[variant]} ${className}`} {...rest}>
      {icon && <span className="opacity-80">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}
