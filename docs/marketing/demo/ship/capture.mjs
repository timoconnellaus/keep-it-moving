// 04 Ship: the end of the checkout interview. The schema the user changed and the plan are marked to save to
// the repo; the user says to wrap up, the agent stops the interview, kim writes them to .kim/, and the agent
// says which files it wrote. The files are real: their paths and line counts go to states.json for the PR panel.
import { mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { sleep } from "../lib.mjs";

export default async function ship({ kim, kimJson, kimIn, wait, page, snap, here, base, repo, git }) {
  const design = `${here}/../design`;
  mkdirSync(`${repo}/.kim/designs`, { recursive: true });
  copyFileSync(`${design}/data-model.dbml`, `${repo}/.kim/designs/data-model.dbml`);
  git("add", "-A");
  git("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "Checkout schema");

  const session = JSON.parse(kimIn(repo, "session", "create", "--title", "Checkout rework", "--open-stage"));
  const S = session.id, T = session.token;
  const D = JSON.parse(kimIn(repo, "design", "pull", S, ".kim/designs/data-model.dbml", "--keep", "--title", "Checkout schema")).artifacts[0].id;
  kim("artifact", "update", S, D, "--file", `${design}/data-model-2.dbml`);
  kim("plan", S, "--file", `${here}/plan.md`);
  const P = kimJson("session", "show", S).artifacts.find((a) => a.kind === "plan").id;
  kimIn(repo, "design", "keep", S, P);
  // The interview so far: every question answered.
  const asked = [
    [{ type: "single-choice", prompt: "Payment provider", options: ["Stripe Checkout", "Paddle", "Our own card form"], default: ["Stripe Checkout"] }, "Stripe Checkout"],
    [{ type: "yes-no", prompt: "Guest checkout", default: ["Yes"] }, "Yes"],
    [{ type: "single-choice", prompt: "Which checkout layout?", options: ["One page", "Two steps"], default: ["One page"] }, "One page"],
    [{ type: "single-choice", prompt: "How should payments be recorded?", options: ["A payments table", "Columns on orders"], default: ["A payments table"], artifactId: D }, "A payments table"],
  ];
  for (const [question, answer] of asked) {
    const id = kimJson("question", "add", S, "--json", JSON.stringify(question)).questions[0].id;
    await fetch(`${base}/api/browser/${T}/questions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ answer }) });
  }
  kim("wait", S, "--idle", "300", "--timeout", "5000");
  kim("artifact", "show", S, P);
  kim("chat", "reply", S, "--text", "That's every question answered. The schema and the plan are marked **Saves to repo**.");
  let waiting = wait(S);

  await page.goto(`${base}/s/${T}`, 4500);
  await snap("start", { settle: 1000 });
  await page.click('.stage-tabs [role="tab"]', "System"); await sleep(1500);
  await snap("system");
  await page.run(`(() => { const t = document.querySelector(".chat textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "Looks good. Wrap it up."); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(300);
  await page.click(".chat-send"); await waiting; await sleep(1500);
  await snap("asked");
  // What an agent runs: write what's kept, say what went where, and stop.
  const written = JSON.parse(kimIn(repo, "design", "write", S));
  console.log("  wrote", JSON.stringify(written).slice(0, 400));
  git("add", "-A");
  const stat = execFileSync("git", ["diff", "--cached", "--numstat"], { cwd: repo, encoding: "utf8" }).trim().split("\n").map((line) => {
    const [added, removed, path] = line.split("\t");
    return { path, added: Number(added) || 0, removed: Number(removed) || 0 };
  });
  const files = stat.map((f) => f.path);
  kim("chat", "reply", S, "--text", `Stopped the interview and wrote ${files.length} files to \`.kim/\` for your PR:\n\n${files.map((f) => `- \`${f}\``).join("\n")}`);
  kimIn(repo, "session", "stop", S, "--no-write");
  await sleep(2500);
  await snap("stopped", { settle: 500 });
  const svg = files.find((f) => f.endsWith(".svg"));
  return { files: stat, svg: svg ? readFileSync(`${repo}/${svg}`, "utf8") : null };
}
