import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Short text an agent wrote, such as a question's prompt or an option:
 * inline Markdown only (bold, italics, code, strikethrough, links).
 * A line that would start a block, such as "1. First" or "- Item", keeps
 * its marker as text.
 */
export function Inline({
  text,
  links = true,
}: {
  text: string;
  /** Off inside a button, which can't hold a link: its text shows instead. */
  links?: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      allowedElements={links ? [...INLINE_ELEMENTS, "a"] : [...INLINE_ELEMENTS]}
      unwrapDisallowed
      components={{
        p: ({ children }) => <>{children}</>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {escapeBlocks(text)}
    </Markdown>
  );
}

const INLINE_ELEMENTS = ["p", "strong", "em", "code", "del", "br"] as const;

/** Escapes what would start a heading, list, quote or rule, so it stays text. */
export function escapeBlocks(text: string): string {
  return text
    .replace(/^(\s*)(#{1,6}|>|[-+*]|\d+[.)])(?=\s|$)/gm, (_, space, mark) =>
      /^\d/.test(mark)
        ? `${space}${mark.slice(0, -1)}\\${mark.slice(-1)}`
        : `${space}\\${mark}`,
    )
    .replace(
      /^(\s*)([-=_*])(\s*\2){2,}\s*$/gm,
      (line) => `\\${line.trimStart()}`,
    );
}

/**
 * The words of inline Markdown without its marks, for labels and titles
 * that can only hold text: "**Decide** `now`" is "Decide now".
 */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(?<![\w*\\])(\*|_)(?=\S)([\s\S]*?\S)\1(?![\w*])/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, "$1");
}
