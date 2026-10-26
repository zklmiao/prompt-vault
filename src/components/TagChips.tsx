interface Props {
  tags: string[];
  onTagClick?: (tag: string) => void;
}

/** 只读的标签胶囊组;传入 onTagClick 时每个标签可点击(用于筛选) */
export default function TagChips({ tags, onTagClick }: Props) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((t) =>
        onTagClick ? (
          <button
            key={t}
            type="button"
            className="chip chip-btn"
            title={`筛选标签「${t}」`}
            onClick={(e) => {
              e.stopPropagation();
              onTagClick(t);
            }}
          >
            #{t}
          </button>
        ) : (
          <span key={t} className="chip">
            #{t}
          </span>
        ),
      )}
    </>
  );
}
