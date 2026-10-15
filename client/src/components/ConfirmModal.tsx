import Modal from "./Modal";
import Button from "./Button";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmModal({ title, message, confirmLabel = "Confirm", danger, onConfirm, onClose }: Props) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="hint" style={{ marginBottom: "0.875rem" }}>
        {message}
      </p>
      <div style={{ display: "flex", gap: "0.625rem", justifyContent: "flex-end" }}>
        <Button onClick={onClose} variant="secondary">
          Cancel
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
