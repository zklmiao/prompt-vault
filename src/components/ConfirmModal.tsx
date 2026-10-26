import Modal from "./Modal";

interface Props {
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmText,
  danger,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal title={title} onCancel={onCancel}>
      <p className="modal-message">{message}</p>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          className={"btn " + (danger ? "danger-solid" : "primary")}
          onClick={onConfirm}
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}
