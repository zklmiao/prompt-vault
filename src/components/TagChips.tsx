import { useI18n } from "../i18n";

interface Props {
  tags: string[];
  onTagClick?: (tag: string) => void;
}

/** 只读的标签胶囊组;传入 onTagClick 时每个标签可点击(用于筛选) */
export default function TagChips({ tags, onTagClick }: Props) {
  const { t } = useI18n();
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tTag) =>
        onTagClick ? (
          <button
            key={tTag}
            type="button"
            className="chip chip-btn"
            title={t("tag.filterTitle", { name: tTag })}
            onClick={(e) => {
              e.stopPropagation();
              onTagClick(tTag);
            }}
          >
            #{tTag}
          </button>
        ) : (
          <span key={tTag} className="chip">
            #{tTag}
          </span>
        ),
      )}
    </>
  );
}
