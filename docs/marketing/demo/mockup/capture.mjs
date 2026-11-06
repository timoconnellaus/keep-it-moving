// 03 Mock up: two order confirmation pages on the Design canvas, beside the question that picks one.
// Hovering an option lights up its frame; the user pins a comment on a button and the agent revises it.
import { sleep } from "../lib.mjs";

export default async function mockup({ kim, kimJson, kimIn, repo, wait, page, snap, here, base }) {
  const session = JSON.parse(kimIn(repo, "session", "create", "--title", "Order confirmation", "--open-stage"));
  const S = session.id, T = session.token;
  const art = (file, title, description) => kimJson("artifact", "add", S, "--file", file, "--kind", "mockup", "--title", title, "--description", description).id;
  const A = art(`${here}/receipt.html`, "Receipt first", "Receipt first, on a phone: what they paid, then what's next");
  const B = art(`${here}/tracking.html`, "Tracking first", "Tracking first, on a phone: the delivery timeline up top");
  kimJson("question", "add", S, "--json", JSON.stringify({ type: "single-choice", prompt: "Which confirmation page?", options: ["Receipt first", "Tracking first"], optionArtifacts: { "Receipt first": A, "Tracking first": B }, default: ["Receipt first"], recommendation: "People check what they paid first. Tracking matters once it ships, and the shipping email links to it." }));
  kim("chat", "reply", S, "--text", "Two confirmation pages are on the canvas, beside the question.");
  let waiting = wait(S);

  await page.goto(`${base}/s/${T}`, 4000);
  await snap("start", { settle: 1000 });
  const card = (label) => page.where(".choice-card", label, 0.5, 0.4);
  await page.mouse(...(await card("Tracking first"))); await sleep(700);
  await snap("hoverB");
  await page.mouse(...(await card("Receipt first"))); await sleep(700);
  await snap("hoverA");
  await page.mouse(700, 840);
  await page.click(".canvas-toolbar button, .react-flow button, button", "Comment"); await sleep(500);
  await snap("commenting");
  await page.clickAt(...(await page.whereIn('iframe[title="Receipt first"]', '[data-name="track order button"]', 0.06, 0.12))); await sleep(1000);
  await snap("pinned");
  await page.run(`(() => { const t = document.querySelector(".chat textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "Make this the main button, and say when it arrives."); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(300);
  await page.click(".chat-send"); await waiting; await sleep(1500);
  await snap("sent");
  kim("artifact", "update", S, A, "--file", `${here}/receipt-2.html`);
  kim("chat", "reply", S, "--text", "Done: **Track order** is the blue button now, and it says it arrives Thu 12 Nov.");
  waiting = wait(S); await sleep(2500);
  await snap("revised", { settle: 500 });
  await page.click(".question.emphasized .submit"); await waiting; await sleep(1500);
  await snap("answered");
}
