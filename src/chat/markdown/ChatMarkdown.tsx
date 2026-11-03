import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "./chatMarkdown.css";
import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import { useMemo, type AnchorHTMLAttributes } from "react";
import { Streamdown, type Components } from "streamdown";
import { openExternal } from "../../lib/backend";
import { codeHighlighter } from "./codeHighlighter";
import { normalizeMath } from "./source";

const plugins = {
  code: codeHighlighter,
  // $...$ is how LaTeX writers write inline math; a stray dollar sign is rarer here.
  math: createMathPlugin({ singleDollarTextMath: true }),
  // Bold or italics closed right before Korean text (**강조**한다) only parse with this.
  cjk,
};

/** Links leave the app for the system browser instead of replacing the window. */
function ExternalLink({ href, children, node: _node, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  return (
    <a
      {...rest}
      href={href}
      className="text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30"
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

const components: Components = { a: ExternalLink };

export interface ChatMarkdownProps {
  text: string;
  /** The answer is still arriving: tolerate unfinished syntax and animate new words. */
  streaming: boolean;
}

/** One block of an AI answer rendered as Markdown with math and highlighted code. */
export default function ChatMarkdown({ text, streaming }: ChatMarkdownProps) {
  const source = useMemo(() => normalizeMath(text), [text]);
  return (
    <Streamdown
      className="chat-markdown"
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      plugins={plugins}
      components={components}
      controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false }, mermaid: false }}
      linkSafety={{ enabled: false }}
    >
      {source}
    </Streamdown>
  );
}
