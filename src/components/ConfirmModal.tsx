import Modal from "./Modal";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  return (
    <Modal title={title} onCancel={onCancel}>
      <p className="modal-message">{message}</p>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          {t("common.cancel")}
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
