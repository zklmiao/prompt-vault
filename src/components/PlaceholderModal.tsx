import { useState } from "react";
import Modal from "./Modal";
import { isComposingEvent } from "../util";
import { useI18n } from "../i18n";

interface Props {
  names: string[];
  initialValues?: Record<string, string>;
  onConfirm: (values: Record<string, string>) => void | Promise<void>;
  onCancel: () => void;
}

export default function PlaceholderModal({
  names,
  initialValues,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const n of names) init[n] = initialValues?.[n] ?? "";
    return init;
  });

  const hasPrefill =
    initialValues && names.some((n) => (initialValues[n] ?? "") !== "");

  return (
    <Modal title={t("fill.title")} onCancel={onCancel}>
      <p className="modal-hint">
        {t("fill.hint", { n: names.length })}
        {hasPrefill && t("fill.prefilled")}
      </p>
      {names.map((n, i) => (
        <label key={n} className="field">
          <span className="label">{n}</span>
          <input
            autoFocus={i === 0}
            value={values[n] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
            onKeyDown={(e) => {
              // 组字期间按 Enter 只是选字,不能触发复制
              if (isComposingEvent(e)) return;
              if (e.key === "Enter" && i === names.length - 1) {
                void onConfirm(values);
              }
            }}
          />
        </label>
      ))}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" onClick={() => void onConfirm(values)}>
          {t("fill.copy")}
        </button>
      </div>
    </Modal>
  );
}
