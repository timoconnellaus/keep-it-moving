// Captures the hero's demos from the real app: `node docs/marketing/demo/capture.mjs [story…]` (all five by
// default). Run `npm run build` first. Each story's capture.mjs drives a fresh interview (the agent's side is kim
// calls, the user's is clicks in headless Chrome) and snapshots the app at each step; its states, and the
// documents its frames showed, go to <story>/states.json.
//
// It runs its own `wrangler dev` with throwaway storage and a kim signed in to it under a throwaway HOME, so it
// never touches your local data, your kim login or your agents' config. SCRATCH (default: a temp folder) keeps
// a screenshot of every state and that storage; KEEP=1 leaves the Worker running at the end, to look around.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { recorder, signedInKim, startChrome, startWorker } from "./lib.mjs";

export const STORIES = ["answer", "design", "mockup", "ship", "share"];
const HERE = fileURLToPath(new URL(".", import.meta.url));
const OWNER = "tim.oconnell.australia@gmail.com";
const chosen = process.argv.slice(2);
for (const name of chosen) if (!STORIES.includes(name)) throw new Error(`No story ${name}; they are ${STORIES.join(", ")}`);
const stories = chosen.length ? chosen : STORIES;

const SCRATCH = process.env.SCRATCH ?? mkdtempSync(`${tmpdir()}/kim-demo-`);
mkdirSync(`${SCRATCH}/home`, { recursive: true });
console.log("scratch:", SCRATCH);
const worker = await startWorker(SCRATCH, OWNER);
let page;
try {
  const cli = await signedInKim(worker.base, `${SCRATCH}/home`);
  page = await startChrome();
  for (const story of stories) {
    console.log(story);
    // Start clean: no other interviews (their open questions would badge the switcher). This is the capture's own storage.
    for (const s of cli.json("session", "list", "--all")) cli.kim("session", "delete", s.id);
    // And no memory of the last story's tabs or toggles.
    await page.goto(`${worker.base}/`, 1500);
    await page.run("localStorage.clear(); sessionStorage.clear(); true");
    // A checkout of the storefront repo for the stories that use its .kim/ folder.
    const repo = mkdtempSync(`${SCRATCH}/storefront-`);
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:acme/storefront.git");
    const { snap, result } = recorder(page, SCRATCH, story);
    const run = (await import(`./${story}/capture.mjs`)).default;
    const meta = await run({
      kim: cli.kim, kimJson: cli.json, kimIn: cli.kimIn, wait: cli.wait,
      page, snap, here: `${HERE}${story}`, base: worker.base, worker, repo, git, owner: OWNER,
    }) ?? {};
    const { states, mocks, urls } = result();
    writeFileSync(`${HERE}${story}/states.json`, JSON.stringify({ order: Object.keys(states), states, mocks, urls, ...meta }, null, 1));
    cli.close();
  }
} finally {
  page?.close();
  if (process.env.KEEP) console.log("Worker left running at", worker.base);
  else await worker.stop();
}
process.exit(0);
