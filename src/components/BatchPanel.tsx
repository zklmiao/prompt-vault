import { useState } from "react";
import TagInput from "./TagInput";
import { IconExport, IconTag, IconTrash, IconUndo } from "./icons";

interface Props {
  count: number;
  trashOpen: boolean;
  allTags: string[];
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onAddTags: (tags: string[]) => void | Promise<void>;
  onBatchDelete: () => void | Promise<void>;
  onBatchExport: () => void | Promise<void>;
  onBatchRestore: () => void | Promise<void>;
  onBatchPurge: () => void;
}

export default function BatchPanel({
  count,
  trashOpen,
  allTags,
  allSelected,
  onSelectAll,
  onClear,
  onAddTags,
  onBatchDelete,
  onBatchExport,
  onBatchRestore,
  onBatchPurge,
}: Props) {
  const [tags, setTags] = useState<string[]>([]);

  const applyTags = () => {
    if (tags.length === 0) return;
    void onAddTags(tags);
    setTags([]);
  };

  return (
    <section className="detail">
      <div className="detail-inner batch-panel">
        <div className="batch-head">
          <h2 className="detail-title">已选 {count} 条</h2>
          <div className="batch-head-actions">
            <button
              className="btn small"
              onClick={onSelectAll}
              disabled={allSelected}
              title="全选当前筛选结果(受搜索与标签筛选影响)"
            >
              全选
            </button>
            <button className="btn small" onClick={onClear}>
              取消选择
            </button>
          </div>
        </div>

        {!trashOpen && (
          <div className="batch-tag-box">
            <div className="field grow">
              <span className="label">批量添加标签(回车确认,可加多个)</span>
              <TagInput value={tags} onChange={setTags} suggestions={allTags} />
            </div>
            <button
              className="btn"
              disabled={tags.length === 0}
              onClick={applyTags}
            >
              <IconTag size={15} /> 添加标签
            </button>
          </div>
        )}

        <div className="batch-actions">
          {trashOpen ? (
            <>
              <button
                className="btn primary"
                onClick={() => void onBatchRestore()}
              >
                <IconUndo size={15} /> 批量恢复
              </button>
              <button
                className="btn danger"
                onClick={() => void onBatchPurge()}
              >
                <IconTrash size={15} /> 批量彻底删除
              </button>
            </>
          ) : (
            <>
              <button
                className="btn danger"
                onClick={() => void onBatchDelete()}
              >
                <IconTrash size={15} /> 批量移入回收站
              </button>
              <button
                className="btn"
                onClick={() => void onBatchExport()}
              >
                <IconExport size={15} /> 导出所选
              </button>
            </>
          )}
        </div>

        <p className="batch-hint muted">
          批量操作只作用于当前列表中的选中项;Ctrl+点击多选,Shift+点击连选,Ctrl+A
          全选,Esc 取消。
        </p>
      </div>
    </section>
  );
}
