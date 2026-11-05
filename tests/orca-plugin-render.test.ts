/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { sanitize, scopeCss } from "../orca-plugin/panel/render.js";

describe("drawing a mockup in the panel", () => {
  it("removes everything that could act, and keeps embedded images", () => {
    const split =
      sanitize(`<!doctype html><html class="dark" data-kim-layout="side"><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>.a{color:red}</style>
<script>alert(1)</script></head><body class="bg-white" onload="steal()">
<a href="https://evil.test" onclick="x()">Link</a><iframe src="https://x.test"></iframe>
<img src="https://x.test/photo.jpg" alt="Team photo"><img src="data:image/png;base64,AAAA">
<form action="https://x.test"><button formaction="javascript:x()">Go</button></form>
<div style="background:url(https://x.test/bg.png)">Hi</div><svg><a xlink:href="javascript:x()"></a></svg></body></html>`);
    expect(split.styles).toEqual([".a{color:red}"]);
    expect(split.rootAttributes).toEqual({
      class: "dark bg-white",
      "data-kim-layout": "side",
    });
    const body = split.body;
    for (const gone of [
      "<script",
      "<iframe",
      "onclick",
      "evil.test",
      "x.test/photo",
      "javascript:",
      "formaction",
      "action=",
      "x.test/bg",
    ])
      expect(body).not.toContain(gone);
    expect(body).toContain("data:image/png;base64,AAAA");
    // An image it couldn't embed shows its alt text instead.
    expect(body).toContain("Team%20photo");
    expect(body).toContain(">Link</a>");
  });

  it("fits the page's CSS to its frame: root selectors, container queries, vh, global rules", () => {
    const { css, global } = scopeCss(
      `:root,:host{--x:1}html{font-size:16px}body.dark>.card,.notbody{color:red}
@media (width >= 48rem){.md\\:flex{display:flex}}
@media screen and (min-width: 768px){.a{b:c}}
@media (prefers-color-scheme: dark){body{x:y}}
.h-\\[50vh\\]{height:50vh}.min-h-screen{min-height:100vh}
@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}
@layer utilities{.p-4{padding:1rem;&:hover{@media (hover:hover){color:red}}}}`,
      800,
    );
    expect(css).toContain(".kim-root,:host{--x:1}");
    expect(css).toContain(".kim-root{font-size:16px}");
    expect(css).toContain(".kim-root.dark>.card,.notbody{color:red}");
    expect(css).toContain("@container kim (width >= 48rem){.md\\:flex");
    expect(css).toContain("@container kim (min-width: 768px){.a");
    expect(css).toContain(
      "@media (prefers-color-scheme: dark){.kim-root{x:y}}",
    );
    expect(css).toContain(".h-\\[50vh\\]{height:400px}");
    expect(css).toContain("min-height:800px");
    expect(css).toContain("@media (hover:hover)");
    expect(css).not.toContain("@property");
    expect(global).toContain("@property --tw-shadow");
  });
});
