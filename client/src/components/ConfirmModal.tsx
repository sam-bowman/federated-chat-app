import Modal from "./Modal";

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
      <p className="hint" style={{ marginBottom: 14 }}>
        {message}
      </p>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className={danger ? "btn-danger" : "btn"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
