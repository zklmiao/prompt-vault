import { useState } from "react";
import { isComposingEvent } from "../util";

interface Props {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}

export default function TagInput({ value, onChange, suggestions }: Props) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);

  const q = text.trim().toLowerCase();
  const candidates = suggestions
    .filter((s) => !value.includes(s))
    .filter((s) => (q ? s.toLowerCase().includes(q) : true))
    .slice(0, 8);

  const add = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (!value.includes(t)) onChange([...value, t]);
    setText("");
  };

  return (
    <div className="tag-input">
      <div className="tag-box">
        {value.map((t) => (
          <span key={t} className="chip removable">
            #{t}
            <button
              type="button"
              className="chip-x"
              onClick={() => onChange(value.filter((x) => x !== t))}
              title="移除标签"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // 组字期间 Enter/逗号/Backspace 都交给输入法,避免把拼音当标签
            if (isComposingEvent(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              add(text);
            } else if (e.key === "," || e.key === "，") {
              e.preventDefault();
              add(text);
            } else if (e.key === "Backspace" && text === "" && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          placeholder={value.length === 0 ? "输入标签,回车确认" : ""}
        />
      </div>
      {focused && candidates.length > 0 && (
        <div className="tag-suggestions">
          {candidates.map((s) => (
            <button
              key={s}
              type="button"
              className="tag-suggestion"
              // onMouseDown 在 input 失焦前触发,保证点击生效
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
            >
              #{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
