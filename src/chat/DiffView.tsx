import { diffLines, diffWordsWithSpace } from "diff";
import { useMemo } from "react";

interface DiffViewProps {
  original: string;
  revised: string;
  mode: "words" | "lines";
}

/** Shows what an AI edit changes before it is applied. */
export function DiffView({ original, revised, mode }: DiffViewProps) {
  const parts = useMemo(
    () => (mode === "words" ? diffWordsWithSpace(original, revised) : diffLines(original, revised)),
    [original, revised, mode],
  );

  if (mode === "lines") {
    return (
      <div className="font-mono text-[12px] leading-[1.55]">
        {parts.map((part, i) =>
          part.value
            .replace(/\n$/, "")
            .split("\n")
            .map((line, j) => (
              <div
                key={`${i}-${j}`}
                className={
                  part.added
                    ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200"
                    : part.removed
                      ? "bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-200"
                      : "text-slate-600 dark:text-slate-400"
                }
              >
                <span className="inline-block w-4 select-none opacity-60">{part.added ? "+" : part.removed ? "-" : " "}</span>
                <span className="whitespace-pre-wrap break-words">{line || " "}</span>
              </div>
            )),
        )}
      </div>
    );
  }

  return (
    <div className="font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-words">
      {parts.map((part, i) => (
        <span
          key={i}
          className={
            part.added
              ? "rounded-sm bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100"
              : part.removed
                ? "rounded-sm bg-red-100 text-red-800 line-through decoration-red-400 dark:bg-red-900/40 dark:text-red-200"
                : undefined
          }
        >
          {part.value}
        </span>
      ))}
    </div>
  );
}
