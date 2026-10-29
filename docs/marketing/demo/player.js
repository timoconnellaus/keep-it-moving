// The product demo is the real app: its built CSS and its DOM, captured at each step of a real
// session, in an iframe. The script scales it to fit and, while it's on screen, plays the session by
// morphing the page from one captured state to the next, with a cursor and typing in between.
(() => {
  const frame = document.getElementById("demo");
  const stage = document.getElementById("stage");
  const app = document.getElementById("demo-app");
  const W = 1440, H = 904;
  const fit = () => {
    const scale = frame.clientWidth / W;
    stage.style.transform = `scale(${scale})`;
    // The frame's height counts its 1px borders.
    frame.style.height = `${H * scale + 2}px`;
    // 24 of the app's pixels: under the browser bar's 44, and clear of the app's own 12px insets at the bottom.
    frame.style.setProperty("--demo-radius", `${Math.max(5, Math.round(24 * scale))}px`);
  };
  fit();
  new ResizeObserver(fit).observe(frame);
  app.addEventListener("load", () => play(app.contentDocument), { once: true });
  app.srcdoc = document.getElementById("demo-doc").textContent;

  function play(doc) {
    // Reduced motion, or no morphdom: the opening state, still.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof morphdom !== "function") return;

    const states = {};
    doc.querySelectorAll("template[data-state]").forEach((t) => (states[t.dataset.state] = t.content.firstElementChild));
    const root = doc.getElementById("root");
    const cursor = doc.getElementById("demo-cursor");
    cursor.hidden = false;
    const $ = (selector) => doc.querySelector(selector);
    let hovered = [];

    let onScreen = false;
    new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(frame);
    const playing = () => onScreen && document.visibilityState === "visible";
    // A pause that only counts time while the demo can be seen.
    const wait = async (ms) => {
      for (let left = ms; left > 0; ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (playing()) left -= 50;
      }
    };

    // Moves to a captured state the way React would re-render: only what changed is touched,
    // so new questions and messages animate in and loaded mockups stay loaded.
    const show = (name) => {
      morphdom($(".shell"), states[name].cloneNode(true), {
        getNodeKey: (node) => (node.nodeType === 1 ? node.getAttribute("data-question-id") || node.id || undefined : undefined),
        onBeforeElUpdated: (from, to) => !from.isEqualNode(to),
      });
      // The pointer is still where it was, so whatever it's over stays hovered.
      hovered.forEach((el) => el.classList.add("demo-hover"));
    };
    // Lines the agent's plan revision added, picked out for a moment.
    const showPlanChange = async (name) => {
      show(name);
      const lines = JSON.parse(doc.querySelector(`template[data-state="${name}"]`).dataset.added || "[]");
      const added = [...doc.querySelectorAll(".stage .doc li")].filter((li) => lines.includes(li.textContent.trim()));
      added.forEach((li) => li.classList.add("demo-new"));
      setTimeout(() => added.forEach((li) => li.classList.add("demo-fade")), 2600);
    };
    const place = (x, y, ms) => {
      cursor.style.transitionDuration = `${ms}ms`;
      cursor.style.transform = `translate(${x - 6}px, ${y - 4}px)`;
    };
    const centre = (el, fx = 0.5, fy = 0.5) => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width * fx, r.top + r.height * fy];
    };
    const hover = (...els) => {
      hovered.forEach((el) => el.classList.remove("demo-hover"));
      hovered = els.filter(Boolean);
      hovered.forEach((el) => el.classList.add("demo-hover"));
    };
    const move = async (el, fx, fy, ms = 900) => {
      place(...centre(el, fx, fy), ms);
      await wait(ms);
    };
    const click = async () => {
      cursor.classList.add("press");
      const r = cursor.getBoundingClientRect();
      const ripple = doc.createElement("span");
      ripple.className = "demo-ripple";
      ripple.style.left = `${r.left + 6}px`;
      ripple.style.top = `${r.top + 4}px`;
      doc.body.append(ripple);
      await wait(160);
      cursor.classList.remove("press");
      await wait(200);
      ripple.remove();
    };
    const card = (option) =>
      [...doc.querySelectorAll(".choice-card")].find((el) => el.querySelector(".choice-card-label")?.firstChild?.textContent === option);

    async function session() {
      doc.body.classList.add("demo-out");
      await wait(400);
      root.replaceChildren(states.start.cloneNode(true));
      hover();
      place(1340, 800, 0);
      doc.body.classList.remove("demo-out");
      await wait(1800);

      // Look at Two steps in the workspace, then back at One page.
      const two = card("Two steps");
      await move(two, 0.5, 0.35);
      hover(two);
      await wait(500);
      await move(two.querySelector(".choice-card-view"), 0.5, 0.5, 500);
      hover(two, two.querySelector(".choice-card-view"));
      await click();
      show("previewB");
      await wait(1900);
      const one = card("One page");
      await move(one, 0.5, 0.35, 700);
      hover(one);
      await move(one.querySelector(".choice-card-view"), 0.5, 0.5, 450);
      hover(one, one.querySelector(".choice-card-view"));
      await click();
      show("previewA");
      await wait(1100);

      // Keep the recommended One page and save it.
      const save = $(".question.emphasized .submit");
      await move(save, 0.5, 0.5, 800);
      hover(save);
      await wait(250);
      await click();
      hover();
      show("answered");
      await move($(".questions"), 0.5, 0.75, 900);
      await wait(900);

      // The agent updates the plan, puts it on screen and asks the next questions.
      await showPlanChange("planned");
      await wait(2600);

      // Ask the agent something in the chat.
      const input = $(".chat textarea");
      await move(input, 0.3, 0.5);
      await click();
      input.classList.add("demo-focus");
      const send = $(".chat-send");
      for (const ch of "Can guests save their address for next time?") {
        input.value += ch;
        send.disabled = false;
        await wait(45);
      }
      await wait(300);
      await move(send, 0.5, 0.5, 500);
      hover(send);
      await click();
      hover();
      show("asked");
      await wait(2300);
      show("replied");
      await wait(2400);

      // Accept the rest of the recommended answers in one go; the agent wraps up.
      const accept = $(".accept-all");
      await move(accept, 0.5, 0.5);
      hover(accept);
      await wait(300);
      await click();
      hover();
      show("accepted");
      await move($(".questions"), 0.5, 0.5, 900);
      await wait(1400);
      await showPlanChange("finished");
      await wait(4200);
    }

    (async () => {
      for (;;) await session();
    })();
  }
})();
