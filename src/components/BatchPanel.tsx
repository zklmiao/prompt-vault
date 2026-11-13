import { useState } from "react";
import TagInput from "./TagInput";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
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
          <h2 className="detail-title">{t("batch.title", { n: count })}</h2>
          <div className="batch-head-actions">
            <button
              className="btn small"
              onClick={onSelectAll}
              disabled={allSelected}
              title={t("batch.selectAllTitle")}
            >
              {t("batch.selectAll")}
            </button>
            <button className="btn small" onClick={onClear}>
              {t("batch.clear")}
            </button>
          </div>
        </div>

        {!trashOpen && (
          <div className="batch-tag-box">
            <div className="field grow">
              <span className="label">{t("batch.addTagsLabel")}</span>
              <TagInput value={tags} onChange={setTags} suggestions={allTags} />
            </div>
            <button
              className="btn"
              disabled={tags.length === 0}
              onClick={applyTags}
            >
              <IconTag size={15} /> {t("batch.addTags")}
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
                <IconUndo size={15} /> {t("batch.restore")}
              </button>
              <button
                className="btn danger"
                onClick={() => void onBatchPurge()}
              >
                <IconTrash size={15} /> {t("batch.purge")}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn danger"
                onClick={() => void onBatchDelete()}
              >
                <IconTrash size={15} /> {t("batch.delete")}
              </button>
              <button
                className="btn"
                onClick={() => void onBatchExport()}
              >
                <IconExport size={15} /> {t("batch.export")}
              </button>
            </>
          )}
        </div>

        <p className="batch-hint muted">{t("batch.hint")}</p>
      </div>
    </section>
  );
}
