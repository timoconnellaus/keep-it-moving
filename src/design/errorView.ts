import { placeLabel, sourceLines, type DesignError } from "./errors.js";
import { esc } from "./svg.js";

/** The error box: what went wrong, where, and the source with the bad line marked. */
export function errorHtml(
  noun: string,
  source: string,
  error: DesignError,
): string {
  const place = placeLabel(error);
  const lines = sourceLines(source, error.line)
    .map(
      (l) =>
        `<span class="ln${l.bad ? " bad" : ""}"${l.bad ? ' id="kim-bad-line"' : ""}><b>${l.number}</b>${esc(l.text) || " "}</span>`,
    )
    .join("");
  return `<section class="kim-error" data-name="parse error" role="alert">
<h2>This ${esc(noun)} has an error</h2>
${place ? `<p class="where">${esc(place)}</p>` : ""}
<p class="message">${esc(error.message)}</p>
${source ? `<pre class="source">${lines}</pre>` : ""}
</section>`;
}
