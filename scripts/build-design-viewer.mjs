#!/usr/bin/env node
/**
 * Bundles the design viewer (src/design/viewer.ts and its CSS) into
 * web-dist/design-viewer/, which the Worker serves to design frames. ESM with
 * code splitting, so each renderer (DBML, D2, Mermaid, OpenAPI) is its own
 * chunk, loaded only for the designs that need it.
 *
 * D2's browser build carries its wasm (and Go's wasm_exec.js) inside the
 * script and runs them in a Worker made from a blob URL. Design frames are
 * sandboxed with an opaque origin, where Chrome refuses that Worker, so the
 * plugin below swaps it for an in-page stand-in that runs the same worker code
 * on the main thread. Nothing is fetched besides the chunk itself.
 * Run after `vite build`, which empties web-dist. `--sizes` lists the chunks.
 */
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outdir = `${root}/web-dist/design-viewer`;

const D2_WORKER =
  'async function hf(){let r=new Blob([pf,If],{type:"text/javascript;charset=utf-8"});return new Worker(URL.createObjectURL(r),{type:"module"})}';
const D2_INLINE = `async function hf(){
  const worker = { onmessage: null, onerror: null, terminate() {},
    postMessage(data) { queueMicrotask(() => port.onmessage && port.onmessage({ data })); } };
  const port = { onmessage: null,
    postMessage(data) { queueMicrotask(() => worker.onmessage && worker.onmessage({ data })); } };
  // The worker code reads the wasm's exports from self.d2, which Go sets on globalThis.
  Object.defineProperty(port, "d2", { get: () => globalThis.d2 });
  new Function("self", pf + "\\n" + If.replace(/^export /gm, ""))(port);
  return worker;
}`;

/** Runs D2's wasm on the main thread instead of in a blob Worker. */
const d2InPage = {
  name: "d2-in-page",
  setup(b) {
    b.onLoad(
      { filter: /@terrastruct[\\/]d2[\\/]dist[\\/]browser[\\/]index\.js$/ },
      (args) => {
        const code = readFileSync(args.path, "utf8");
        if (!code.includes(D2_WORKER))
          throw new Error(
            "@terrastruct/d2 changed how it starts its Worker; update scripts/build-design-viewer.mjs",
          );
        return { contents: code.replace(D2_WORKER, D2_INLINE), loader: "js" };
      },
    );
  },
};

rmSync(outdir, { recursive: true, force: true });
const result = await build({
  entryPoints: { viewer: `${root}/src/design/viewer.ts` },
  outdir,
  bundle: true,
  format: "esm",
  splitting: true,
  minify: true,
  platform: "browser",
  target: "es2022",
  chunkNames: "chunks/[name]-[hash]",
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  plugins: [d2InPage],
});

if (process.argv.includes("--sizes")) {
  const outputs = Object.entries(result.metafile.outputs).sort(
    (a, b) => b[1].bytes - a[1].bytes,
  );
  for (const [file, { bytes }] of outputs)
    console.log(
      `${(bytes / 1024).toFixed(1).padStart(9)} KiB  ${relative(outdir, file)}`,
    );
}
