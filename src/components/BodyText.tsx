import { bodySegments } from "../util";

/** 正文渲染:{{变量}} 高亮为胶囊,其余原样 */
export default function BodyText({ text }: { text: string }) {
  return (
    <>
      {bodySegments(text).map((s, i) =>
        s.ph !== undefined ? (
          <span key={i} className="ph">{`{{${s.ph}}}`}</span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
