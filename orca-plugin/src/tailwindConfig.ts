/**
 * Reads an inline Tailwind v3 config (`tailwind.config = { … }`) as data,
 * never running it: a mockup is anyone's HTML. Only plain literals parse
 * (objects, arrays, strings, numbers, booleans); anything else, such as a
 * function or a spread, gives null and the mockup keeps Tailwind's
 * defaults.
 */

type Literal =
  string | number | boolean | null | Literal[] | { [key: string]: Literal };

const CONFIG = /tailwind\.config\s*=\s*\{/;

/** The theme CSS (`@theme { … }`) for the config in a page's scripts, or "". */
export function themeFromPage(html: string): string {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1]!;
    const found = CONFIG.exec(script);
    if (!found) continue;
    const config = parseLiteral(script, found.index + found[0].length - 1);
    return config && typeof config === "object" && !Array.isArray(config)
      ? themeCss(config)
      : "";
  }
  return "";
}

/** CSS variables in Tailwind v4's names for a v3 config's theme. */
export function themeCss(config: { [key: string]: Literal }): string {
  const theme = asObject(config.theme);
  const merged = { ...theme, ...asObject(theme.extend) };
  const lines: string[] = [];
  const add = (name: string, value: Literal) => {
    if (typeof value === "string" || typeof value === "number")
      lines.push(`  --${name}: ${String(value).replace(/[;{}]/g, "")};`);
  };
  const family = (value: Literal) =>
    (Array.isArray(value) ? value : [value])
      .filter((part): part is string => typeof part === "string")
      .map((part) =>
        /\s/.test(part) && !/^["']/.test(part) ? `"${part}"` : part,
      )
      .join(", ");
  for (const [name, value] of Object.entries(asObject(merged.colors))) {
    const key = safe(name);
    if (!key) continue;
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [shade, color] of Object.entries(value)) {
        if (shade === "DEFAULT") add(`color-${key}`, color);
        else if (safe(shade)) add(`color-${key}-${safe(shade)}`, color);
      }
    else add(`color-${key}`, value);
  }
  for (const [name, value] of Object.entries(asObject(merged.fontFamily)))
    if (safe(name)) add(`font-${safe(name)}`, family(value));
  for (const [name, value] of Object.entries(asObject(merged.borderRadius)))
    if (safe(name))
      add(name === "DEFAULT" ? "radius" : `radius-${safe(name)}`, value);
  for (const [name, value] of Object.entries(asObject(merged.boxShadow)))
    if (safe(name))
      add(name === "DEFAULT" ? "shadow" : `shadow-${safe(name)}`, value);
  return lines.length ? `@theme {\n${lines.join("\n")}\n}` : "";
}

const asObject = (value: Literal | undefined): { [key: string]: Literal } =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const safe = (name: string) =>
  /^[A-Za-z0-9_-]+$/.test(name) ? name : name === "DEFAULT" ? name : "";

/** Parses the literal starting at `start`, or null if it isn't plain data. */
export function parseLiteral(source: string, start = 0): Literal | null {
  let at = start;
  const fail = (): never => {
    throw new Error("not a literal");
  };
  const space = () => {
    for (;;) {
      const rest = source.slice(at);
      const skipped = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
      if (!skipped) return;
      at += skipped[0].length;
    }
  };
  const value = (): Literal => {
    space();
    const char = source[at];
    if (char === "{") return object();
    if (char === "[") return array();
    if (char === '"' || char === "'" || char === "`") return string();
    const number = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(at));
    if (number) {
      at += number[0].length;
      return Number(number[0]);
    }
    for (const [word, literal] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (
        source.startsWith(word, at) &&
        !/[\w$]/.test(source[at + word.length] ?? "")
      ) {
        at += word.length;
        return literal;
      }
    return fail();
  };
  const string = (): string => {
    const quote = source[at]!;
    let out = "";
    at++;
    while (at < source.length && source[at] !== quote) {
      if (quote === "`" && source.startsWith("${", at)) fail();
      if (source[at] === "\\") {
        at++;
        const escaped = source[at] ?? "";
        out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      } else out += source[at];
      at++;
    }
    if (source[at] !== quote) fail();
    at++;
    return out;
  };
  const key = (): string => {
    space();
    const char = source[at];
    if (char === '"' || char === "'") return string();
    const name = /^[A-Za-z_$][\w$-]*|^\d+/.exec(source.slice(at));
    if (!name) return fail();
    at += name[0].length;
    return name[0];
  };
  const object = (): { [key: string]: Literal } => {
    const out: { [key: string]: Literal } = {};
    at++;
    for (;;) {
      space();
      if (source[at] === "}") {
        at++;
        return out;
      }
      const name = key();
      space();
      if (source[at] !== ":") fail();
      at++;
      out[name] = value();
      space();
      if (source[at] === ",") at++;
      else if (source[at] !== "}") fail();
    }
  };
  const array = (): Literal[] => {
    const out: Literal[] = [];
    at++;
    for (;;) {
      space();
      if (source[at] === "]") {
        at++;
        return out;
      }
      out.push(value());
      space();
      if (source[at] === ",") at++;
      else if (source[at] !== "]") fail();
    }
  };
  try {
    return value();
  } catch {
    return null;
  }
}
