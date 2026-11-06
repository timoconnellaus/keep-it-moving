// 02 Design: the agent pulls the storefront's data model from the repo's .kim/ folder onto the System tab.
// The user pins a comment on the orders table, and the agent changes the design: the canvas shows what's new
// and what changed compared with the repo.
import { mkdirSync, copyFileSync } from "node:fs";
import { sleep } from "../lib.mjs";

export default async function design({ kimJson, kimIn, kim, wait, page, snap, here, base, repo, git }) {
  mkdirSync(`${repo}/.kim/designs`, { recursive: true });
  copyFileSync(`${here}/data-model.dbml`, `${repo}/.kim/designs/data-model.dbml`);
  git("add", "-A");
  git("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "Checkout schema");

  const session = JSON.parse(kimIn(repo, "session", "create", "--title", "Checkout rework", "--open-stage"));
  const S = session.id, T = session.token;
  const pulled = JSON.parse(kimIn(repo, "design", "pull", S, ".kim/designs/data-model.dbml", "--keep", "--show", "--title", "Checkout schema"));
  const D = pulled.artifacts[0].id;
  kimJson("question", "add", S, "--json", JSON.stringify({ type: "single-choice", prompt: "How should payments be recorded?", options: ["A payments table", "Columns on orders"], default: ["A payments table"], recommendation: "A row per Stripe session keeps every attempt and refund; an order stays one row.", artifactId: D }));
  kim("chat", "reply", S, "--text", "I pulled the checkout schema from `.kim/designs/`. It's on the System tab.");
  let waiting = wait(S);

  await page.goto(`${base}/s/${T}`, 4000);
  await snap("start", { settle: 1500 });
  // Full screen, to read it; then a comment on the orders table, which brings the chat back.
  await page.click(".system-frame .full-toggle"); await sleep(1200);
  await snap("full");
  await page.click(".system-frame .pbtn", "Comment"); await sleep(400);
  await snap("commenting");
  await page.clickAt(...(await page.whereIn(".system-frame iframe", '[data-name="orders table"]', 0.62, 0.1))); await sleep(1000);
  await snap("pinned");
  await page.run(`(() => { const t = document.querySelector(".chat textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "Guests have no account. Where does their email go?"); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(300);
  await page.click(".chat-send"); await waiting; await sleep(1500);
  await snap("sent");
  kim("artifact", "update", S, D, "--file", `${here}/data-model-2.dbml`);
  kim("chat", "reply", S, "--text", "Made `user_id` optional and added `email` to orders, so a guest's receipt has somewhere to go. I also added `payments`, one row per Stripe Checkout session.");
  waiting = wait(S); await sleep(2500);
  await snap("updated", { settle: 1000 });
  await page.click(".system-frame .full-toggle"); await sleep(1200);
  await snap("review");
}
