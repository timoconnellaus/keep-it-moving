// 05 Share: questions only the client can answer. The user assigns the interview to sam@client.co; the home
// page shows it waiting on them; Sam answers (the Worker restarts signed in as Sam, as their browser would be)
// and the answers come back to the user's page and the agent.
import { sleep } from "../lib.mjs";

const CLIENT = "sam@client.co";

export default async function share({ kim, kimJson, kimIn, wait, page, snap, base, repo, worker, owner }) {
  // Other interviews on the home page, as there would be.
  const done = JSON.parse(kimIn(repo, "session", "create", "--title", "Checkout rework"));
  kim("session", "stop", done.id, "--no-write");
  const other = JSON.parse(kimIn(repo, "session", "create", "--title", "Order confirmation"));
  kimJson("question", "add", other.id, "--json", JSON.stringify({ type: "single-choice", prompt: "Which confirmation page?", options: ["Receipt first", "Tracking first"], default: ["Receipt first"] }));

  const session = JSON.parse(kimIn(repo, "session", "create", "--title", "Launch details from the client"));
  const S = session.id, T = session.token;
  const q = (json) => kimJson("question", "add", S, "--json", JSON.stringify(json)).questions[0].id;
  const Q1 = q({ type: "multiple-choice", prompt: "Where do you ship at launch?", options: ["Australia", "New Zealand", "United States"], default: ["Australia"] });
  const Q2 = q({ type: "number", prompt: "Free shipping on orders over (AUD)", default: "80" });
  const Q3 = q({ type: "single-choice", prompt: "How long do customers have to return an item?", options: ["14 days", "30 days", "No returns"], default: ["30 days"], recommendation: "30 days is what most Australian stores offer, and it's what Stripe's dispute window covers." });
  const Q4 = q({ type: "text", prompt: "Anything we should know before launch?" });
  wait(S);

  await page.goto(`${base}/s/${T}`, 4000);
  await snap("start", { settle: 500 });
  await page.click(".assign-button"); await sleep(500);
  await snap("assigning");
  await page.clickAt(...(await page.where(".assign-menu input"))); await sleep(200);
  await page.type(CLIENT); await sleep(300);
  await snap("typed");
  await page.click('.assign-menu button[type="submit"]'); await sleep(1500);
  await snap("assigned");
  await page.goto(`${base}/`, 2500);
  await page.click(".get-started-dismiss").catch(() => {}); await sleep(500);
  await snap("home");

  // Sam signs in at the link and answers. Their answers carry their address.
  await worker.as(CLIENT);
  const answer = (id, text) => fetch(`${base}/api/browser/${T}/questions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ answer: text }) }).then((r) => { if (!r.ok) throw new Error(`answer as ${CLIENT}: HTTP ${r.status}`); });
  await answer(Q1, "Australia, New Zealand");
  await answer(Q2, "100");
  await answer(Q3, "30 days");
  await answer(Q4, "We're closed 24 Dec to 2 Jan, so nothing ships then.");
  await worker.as(owner);
  console.log("  batch", kim("wait", S, "--idle", "300", "--timeout", "10000").slice(0, 300));
  kim("chat", "reply", S, "--text", "Sam's answers are in: Australia and New Zealand, free shipping over $100, 30-day returns, and no shipping 24 Dec to 2 Jan. I've put them in the plan.");
  wait(S);
  await page.goto(`${base}/`, 3000);
  await snap("back");
  await page.goto(`${base}/s/${T}`, 4000);
  await snap("answers", { settle: 500 });
}
