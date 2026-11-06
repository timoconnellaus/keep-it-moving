// 01 Answer: the checkout interview. Look at both layouts, keep the recommended one, see the plan
// update, ask the agent something in the chat, and accept the rest of the defaults.
import { readFileSync } from "node:fs";
import { sleep } from "../lib.mjs";

export default async function answer({ kim, kimJson, kimIn, repo, wait, page, snap, here, base }) {
  const session = JSON.parse(kimIn(repo, "session", "create", "--title", "Checkout rework", "--open-stage"));
  const S = session.id, T = session.token;
  kim("plan", S, "--file", `${here}/plan-1.md`);
  const art = (file, title, description) => kimJson("artifact", "add", S, "--file", file, "--kind", "mockup", "--title", title, "--description", description).id;
  const A = art(`${here}/layout-a.html`, "Layout A", "Layout A · one page");
  const B = art(`${here}/layout-b.html`, "Layout B", "Layout B · two steps");
  const q = (json) => kimJson("question", "add", S, "--json", JSON.stringify(json)).questions[0].id;
  const Q1 = q({ type: "single-choice", prompt: "Payment provider", options: ["Stripe Checkout", "Paddle", "Our own card form"], default: ["Stripe Checkout"], recommendation: "Stripe hosts the card form, so PCI scope stays tiny." });
  const Q2 = q({ type: "yes-no", prompt: "Guest checkout", default: ["Yes"], recommendation: "Forcing an account is the biggest single cause of drop-off." });
  q({ type: "single-choice", prompt: "Which checkout layout?", options: ["One page", "Two steps"], optionArtifacts: { "One page": A, "Two steps": B }, default: ["One page"], recommendation: "One page keeps the order summary in view while people pay, and it's one fewer screen to drop off on." });
  const answerAs = (id, text) => fetch(`${base}/api/browser/${T}/questions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ answer: text }) });
  await answerAs(Q1, "Stripe Checkout");
  await answerAs(Q2, "Yes");
  kim("wait", S, "--idle", "300", "--timeout", "5000");
  kim("chat", "reply", S, "--text", "I've drafted two checkout layouts. They're on the canvas.");
  kim("artifact", "show", S, A);
  let waiting = wait(S);

  await page.goto(`${base}/s/${T}`, 3500);
  await snap("start");
  await page.click(".choice-card-view", "View Two steps on the canvas"); await sleep(1500);
  await snap("previewB");
  await page.click(".choice-card-view", "View One page on the canvas"); await sleep(1500);
  await snap("previewA");
  await page.click(".question.emphasized .submit"); await waiting; await sleep(1500);
  await snap("answered");
  kim("plan", S, "--file", `${here}/plan-2.md`);
  kim("artifact", "show", S, kimJson("session", "show", S).artifacts.find((a) => a.kind === "plan").id);
  q({ type: "single-choice", prompt: "Where should tax be calculated?", options: ["Stripe Tax at checkout", "Our own rate table", "Prices include tax"], default: ["Stripe Tax at checkout"], recommendation: "You're on Stripe Checkout already, and Stripe Tax covers AU GST and EU VAT." });
  q({ type: "single-choice", prompt: "Who sends receipts?", options: ["Stripe's receipt emails", "Our own emails"], default: ["Stripe's receipt emails"], recommendation: "Stripe sends them from your domain with your logo; no templates to keep." });
  q({ type: "single-choice", prompt: "How are refunds made?", options: ["From the Stripe dashboard", "An admin page of our own"], default: ["From the Stripe dashboard"], recommendation: "Refunds are rare at this size; the dashboard covers them." });
  waiting = wait(S); await sleep(2000);
  await snap("planned");
  await page.run(`(() => { const t = document.querySelector(".chat textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "Can guests save their address for next time?"); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(300);
  await page.click(".chat-send"); await waiting; await sleep(1500);
  await snap("asked");
  kim("chat", "reply", S, "--text", "Yes. Stripe keeps it on the customer, so signing up later picks it up.");
  waiting = wait(S); await sleep(2000);
  await snap("replied");
  await page.click(".accept-all"); await waiting; await sleep(1500);
  await snap("accepted");
  kim("plan", S, "--file", `${here}/plan-3.md`);
  kim("session", "stop", S, "--no-write"); await sleep(2000);
  await snap("finished");

  // The lines each plan revision added, for the player to pick out.
  const bullets = (n) => readFileSync(`${here}/plan-${n}.md`, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const newLines = (from, to) => bullets(to).filter((line) => !bullets(from).includes(line));
  return { added: { planned: newLines(1, 2), finished: newLines(2, 3) } };
}
