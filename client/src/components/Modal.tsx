import type { ReactNode } from "react";
import Button from "./Button";

export default function Modal({
  title,
  onClose,
  children,
  width = 400,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        role="presentation"
        className="auth-card"
        style={{ width, maxWidth: "calc(100vw - 32px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ fontSize: 18 }}>{title}</h1>
          <Button onClick={onClose} variant="secondary" size="sm">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
