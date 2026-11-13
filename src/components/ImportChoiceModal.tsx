import Modal from "./Modal";
import { useI18n } from "../i18n";
import type { ImportMode } from "../types";

interface Props {
  count: number;
  onApply: (mode: ImportMode) => void;
  onCancel: () => void;
}

export default function ImportChoiceModal({ count, onApply, onCancel }: Props) {
  const { t } = useI18n();
  return (
    <Modal title={t("import.title")} onCancel={onCancel}>
      <p className="modal-message">{t("import.count", { n: count })}</p>
      <div className="import-options">
        <button className="option" onClick={() => onApply("merge")}>
          <b>{t("import.merge")}</b>
          <span>{t("import.mergeDesc")}</span>
        </button>
        <button className="option" onClick={() => onApply("overwrite")}>
          <b>{t("import.overwrite")}</b>
          <span>{t("import.overwriteDesc")}</span>
        </button>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}
