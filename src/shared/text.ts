/**
 * Text an agent passed as one shell argument with "\n" typed for each line
 * break, which shells keep as a backslash and an n: those become line
 * breaks. Text with a real line break in it, and "\n" inside `code`, are
 * left as written.
 */
export function literalLineBreaks(text: string): string {
  if (/\r|\n/.test(text) || !text.includes("\\n")) return text;
  // Code spans keep theirs: `"a\nb"` means the escape.
  return text
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 ? part : part.replace(/(?<!\\)(?:\\r)?\\n/g, "\n"),
    )
    .join("");
}
