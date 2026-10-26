import Modal from "./Modal";
import type { ImportMode } from "../types";

interface Props {
  count: number;
  onApply: (mode: ImportMode) => void;
  onCancel: () => void;
}

export default function ImportChoiceModal({ count, onApply, onCancel }: Props) {
  return (
    <Modal title="选择导入方式" onCancel={onCancel}>
      <p className="modal-message">导入文件包含 {count} 条记录。</p>
      <div className="import-options">
        <button className="option" onClick={() => onApply("merge")}>
          <b>合并(推荐)</b>
          <span>
            按 id 去重并入现有收藏;同一条记录两边都有时,保留更新时间较新的版本。
          </span>
        </button>
        <button className="option" onClick={() => onApply("overwrite")}>
          <b>覆盖</b>
          <span>清空当前全部收藏,完全替换为文件内容(当前数据仍会备份为 .bak)。</span>
        </button>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </Modal>
  );
}
