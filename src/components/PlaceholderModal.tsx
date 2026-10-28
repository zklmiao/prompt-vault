import { useState } from "react";
import Modal from "./Modal";
import { isComposingEvent } from "../util";

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
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const n of names) init[n] = initialValues?.[n] ?? "";
    return init;
  });

  const hasPrefill =
    initialValues && names.some((n) => (initialValues[n] ?? "") !== "");

  return (
    <Modal title="填写变量后复制" onCancel={onCancel}>
      <p className="modal-hint">
        检测到 {names.length} 个占位符;留空的变量将保持原样复制。
        {hasPrefill && "已预填上次的填写值。"}
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
          取消
        </button>
        <button className="btn primary" onClick={() => void onConfirm(values)}>
          复制
        </button>
      </div>
    </Modal>
  );
}
