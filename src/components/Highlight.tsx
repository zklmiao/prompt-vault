import type { MatchRange } from "../util";

interface Props {
  text: string;
  ranges?: MatchRange[];
}

/** 按匹配区间渲染高亮(区间需已排序合并;越界区间会被忽略) */
export default function Highlight({ text, ranges }: Props) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const r of ranges) {
    const start = Math.max(0, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start < cursor) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={`${start}-${end}`} className="hl">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
