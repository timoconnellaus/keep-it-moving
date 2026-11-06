// The hero's demos are the real app: its built CSS and its DOM, captured at each step of five real sessions,
// in one iframe. The script scales it to fit, and plays the chosen tab's session by morphing the page from one
// captured state to the next, with a cursor and typing in between. Each tab's bar fills as its demo plays (only
// while it's on screen), and the next tab starts when it ends. With reduced motion, each tab shows its last state.
(() => {
  const frame = document.getElementById("demo");
  const stage = document.getElementById("stage");
  const app = document.getElementById("demo-app");
  const urlBar = frame.querySelector(".url");
  const tablist = document.getElementById("demo-tabs");
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panel = document.getElementById("demo-panel");
  const W = 1440, H = 904;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof morphdom !== "function";
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
  if (still) document.documentElement.classList.add("demo-still");

  // What each tab plays, how long that takes (its bar's 100%), and what the frame says it shows.
  const STORIES = {
    answer: { ms: 32100, label: "Answering a question about two checkout mockups, the plan updating, a chat with the agent, and accepting the remaining defaults" },
    design: { ms: 25600, label: "The checkout data model pulled from the repo, a comment pinned on the orders table, and the agent's changes highlighted against the repo" },
    mockup: { ms: 26000, label: "Two confirmation page mockups beside the question, hovering each option, a comment pinned on a button, and the agent revising it" },
    ship: { ms: 20800, label: "Wrapping up: the agent stops the interview and writes the data model, its SVG and the plan to the repo's .kim folder for the pull request" },
    share: { ms: 20400, label: "Assigning the interview to sam@client.co, the home page showing it waiting on them, and their answers coming back" },
  };
  const names = tabs.map((tab) => tab.dataset.story);
  let current = 0;
  let doc = null;

  const select = (index, { focus = false } = {}) => {
    current = index;
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      tab.style.setProperty("--progress", "0");
    });
    const tab = tabs[index];
    panel.setAttribute("aria-labelledby", tab.id);
    frame.setAttribute("aria-label", `Keep it moving in use: ${STORIES[names[index]].label}`);
    if (focus) tab.focus({ preventScroll: true });
    // Keep the tab in view where the row scrolls sideways (phones), without scrolling the page.
    if (tablist.scrollWidth > tablist.clientWidth) {
      const left = tab.offsetLeft - (tablist.clientWidth - tab.offsetWidth) / 2;
      tablist.scrollTo({ left: Math.max(0, left), behavior: still ? "auto" : "smooth" });
    }
    if (doc) run(index);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(i));
    tab.addEventListener("keydown", (event) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      select((to + tabs.length) % tabs.length, { focus: true });
    });
  });

  app.addEventListener("load", () => { doc = app.contentDocument; setup(); select(current); }, { once: true });
  app.srcdoc = document.getElementById("demo-doc").textContent;

  let run = () => {};
  function setup() {
    const root = doc.getElementById("root");
    const cursor = doc.getElementById("demo-cursor");
    const pr = doc.getElementById("demo-pr");
    const $ = (selector) => doc.querySelector(selector);
    const template = (story, state) => doc.querySelector(`template[data-story="${story}"][data-state="${state}"]`);
    const statesOf = (story) => [...doc.querySelectorAll(`template[data-story="${story}"]`)].map((t) => t.dataset.state);
    const meta = (story) => JSON.parse(doc.querySelector(`template[data-meta="${story}"]`)?.content.textContent || "{}");
    const mock = (key) => doc.querySelector(`template[data-mock="${key}"]`)?.content.textContent ?? "";
    // Frames show their captured documents; one that shows the same document again isn't reloaded.
    const hydrate = (el) => {
      if (el.nodeType !== 1) return;
      const frames = el.tagName === "IFRAME" ? [el] : el.querySelectorAll("iframe[data-mock]");
      frames.forEach((f) => { if (f.dataset.mock && f.dataset.loaded !== f.dataset.mock) { f.srcdoc = mock(f.dataset.mock); f.dataset.loaded = f.dataset.mock; } });
    };
    let story = names[0];
    let hovered = [];

    // One clock for the whole demo: it only runs while the demo can be seen, and every pause counts on it.
    let onScreen = false;
    new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(frame);
    const playing = () => onScreen && document.visibilityState === "visible";
    const ABORT = Symbol("switched tabs");
    let gen = 0, played = 0, last = performance.now();
    let waiters = [];
    const tick = (now) => {
      if (playing()) played += Math.min(now - last, 100);
      last = now;
      waiters = waiters.filter((w) => {
        if (w.gen !== gen) return w.reject(ABORT), false;
        if (played >= w.at) return w.resolve(), false;
        return true;
      });
      if (!still) tabs[current].style.setProperty("--progress", String(Math.min(played / STORIES[story].ms, 1)));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const wait = (ms) => new Promise((resolve, reject) => waiters.push({ at: played + ms, gen, resolve, reject }));

    const urlOf = (name) => template(story, name)?.dataset.url;
    // Moves to a captured state the way React would re-render: only what changed is touched,
    // so new questions and messages animate in and loaded frames stay loaded.
    const show = (name) => {
      morphdom(root.firstElementChild, template(story, name).content.firstElementChild.cloneNode(true), {
        getNodeKey: (node) => (node.nodeType === 1 ? node.getAttribute("data-question-id") || node.id || undefined : undefined),
        onBeforeElUpdated: (from, to) => {
          if (from.tagName === "IFRAME") {
            if (from.dataset.loaded === to.dataset.mock) { to.setAttribute("srcdoc", from.getAttribute("srcdoc") ?? ""); to.dataset.loaded = from.dataset.loaded; }
            else if (to.dataset.mock) { to.setAttribute("srcdoc", mock(to.dataset.mock)); to.dataset.loaded = to.dataset.mock; }
          }
          return !from.isEqualNode(to);
        },
        onNodeAdded: (node) => { hydrate(node); return node; },
      });
      urlBar.textContent = urlOf(name);
      // The pointer is still where it was, so whatever it's over stays hovered.
      hovered.forEach((el) => el.classList.add("demo-hover"));
    };
    // Lines the agent's plan revision added, picked out for a moment.
    const showPlanChange = (name) => {
      show(name);
      const lines = JSON.parse(template(story, name).dataset.added || "[]");
      const added = [...doc.querySelectorAll(".stage .doc li")].filter((li) => lines.includes(li.textContent.trim()));
      flash(added);
    };
    const flash = (els) => {
      els.forEach((el) => el.classList.add("demo-new"));
      setTimeout(() => els.forEach((el) => el.classList.add("demo-fade")), 2600);
    };
    const place = (x, y, ms) => {
      cursor.style.transitionDuration = `${ms}ms`;
      cursor.style.transform = `translate(${x - 6}px, ${y - 4}px)`;
    };
    const centre = (el, fx = 0.5, fy = 0.5) => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width * fx, r.top + r.height * fy];
    };
    // A point on something inside one of the app's frames, as the frame is scaled on screen.
    const inside = (iframe, selector, fx = 0.5, fy = 0.5) => {
      const box = iframe.getBoundingClientRect();
      const el = iframe.contentDocument?.querySelector(selector);
      if (!el) return centre(iframe);
      const s = box.width / iframe.offsetWidth;
      const r = el.getBoundingClientRect();
      return [box.left + (r.left + r.width * fx) * s, box.top + (r.top + r.height * fy) * s];
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
    const moveTo = async ([x, y], ms = 900) => {
      place(x, y, ms);
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
      setTimeout(() => ripple.remove(), 600);
      await wait(160);
      cursor.classList.remove("press");
      await wait(200);
    };
    // Point at something, click it, and move to the state that follows.
    const press = async (el, next, { fx = 0.5, fy = 0.5, ms = 800, pause = 250 } = {}) => {
      await move(el, fx, fy, ms);
      hover(el);
      await wait(pause);
      await click();
      hover();
      if (next) show(next);
    };
    const type = async (input, text, button) => {
      input.classList.add("demo-focus");
      for (const ch of text) {
        input.value += ch;
        if (button) button.disabled = false;
        await wait(45);
      }
    };
    // Write in the chat and send it.
    const say = async (text, next) => {
      const input = $(".chat textarea");
      await move(input, 0.3, 0.5);
      await click();
      await type(input, text, $(".chat-send"));
      await wait(300);
      await press($(".chat-send"), next, { ms: 500, pause: 0 });
    };
    const card = (option) =>
      [...doc.querySelectorAll(".choice-card")].find((el) => el.querySelector(".choice-card-label")?.firstChild?.textContent === option);
    const byText = (selector, text) => [...doc.querySelectorAll(selector)].find((el) => el.textContent.includes(text));
    const fade = async (out) => {
      doc.body.classList.toggle("demo-out", out);
      await wait(350);
    };
    // The story's first state, from a blank page.
    const enter = async () => {
      if (root.firstElementChild) await fade(true);
      pr.classList.remove("on");
      pr.innerHTML = "";
      const first = template(story, statesOf(story)[0]).content.firstElementChild.cloneNode(true);
      hydrate(first);
      root.replaceChildren(first);
      urlBar.textContent = urlOf(statesOf(story)[0]);
      hover();
      place(1340, 800, 0);
      cursor.hidden = still;
      doc.body.classList.remove("demo-out");
    };
    // 04's pull request: the files kim wrote, with their real line counts and the SVG it drew.
    const drawPr = () => {
      const { files = [], svg } = meta("ship");
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      pr.innerHTML = `<div class="k">Your pull request</div>
        <div class="h"><span class="st">Open</span><b>Checkout rework</b><span>checkout-rework → main</span></div>
        <div class="body"><div class="files">${files.map((f) => `<div class="file">${esc(f.path)}<span class="d"><span class="plus">+${f.added}</span>${f.removed ? ` <span class="minus">−${f.removed}</span>` : ""}</span></div>`).join("")}
        <div class="more">and the code it plans</div></div>
        ${svg ? `<div class="svg"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}"><span>data-model.svg</span></div>` : ""}</div>`;
    };

    const PLAYS = {
      async answer() {
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
        await press($(".question.emphasized .submit"), "answered");
        await move($(".questions"), 0.5, 0.75, 900);
        await wait(900);
        // The agent updates the plan, puts it on screen and asks the next questions.
        showPlanChange("planned");
        await wait(2600);
        // Ask the agent something in the chat.
        await say("Can guests save their address for next time?", "asked");
        await wait(2300);
        show("replied");
        await wait(2400);
        // Accept the rest of the recommended answers in one go; the agent wraps up.
        await press($(".accept-all"), "accepted", { ms: 900, pause: 300 });
        await move($(".questions"), 0.5, 0.5, 900);
        await wait(1400);
        showPlanChange("finished");
        await wait(4200);
      },
      async design() {
        await wait(1800);
        // Open the data model full screen to read it, and pin a comment on the orders table.
        await press($(".system-frame .full-toggle"), "full", { pause: 200 });
        await wait(1700);
        await press(byText(".preview.full .pbtn", "Comment"), "commenting", { ms: 700 });
        await wait(700);
        await moveTo(inside($(".system-frame iframe"), '[data-name="orders table"]', 0.62, 0.1), 1000);
        await click();
        show("pinned");
        await wait(900);
        await say("Guests have no account. Where does their email go?", "sent");
        await wait(2000);
        // The agent changes the design: new and changed tables light up, compared with the repo.
        show("updated");
        await wait(2600);
        await press($(".system-frame .full-toggle"), "review", { pause: 200 });
        // Out of the way of the drawing.
        place(1380, 820, 900);
        await wait(5000);
      },
      async mockup() {
        await wait(1800);
        // Hovering an option lights up its mockup on the canvas.
        const tracking = card("Tracking first");
        await move(tracking, 0.5, 0.35);
        hover(tracking);
        show("hoverB");
        await wait(1500);
        const receipt = card("Receipt first");
        await move(receipt, 0.5, 0.35, 700);
        hover(receipt);
        show("hoverA");
        await wait(1300);
        // Pin a comment on its button, and ask for a change.
        await press($('.tab-panel button[title="Comment (C)"]'), "commenting", { ms: 900 });
        await wait(700);
        await moveTo(inside($('iframe[title="Receipt first"]'), '[data-name="track order button"]', 0.06, 0.12), 1000);
        await click();
        show("pinned");
        await wait(900);
        await say("Make this the main button, and say when it arrives.", "sent");
        await wait(2000);
        show("revised");
        await wait(2800);
        await press($(".question.emphasized .submit"), "answered", { ms: 900 });
        await wait(3400);
      },
      async ship() {
        await wait(2200);
        // The plan and the changed schema are both marked to save to the repo.
        await press(byText('.stage-tabs [role="tab"]', "System"), "system", { ms: 900 });
        await wait(2400);
        await say("Looks good. Wrap it up.", "asked");
        await wait(1800);
        show("stopped");
        await wait(2400);
        // What lands in the pull request.
        drawPr();
        pr.classList.add("on");
        for (const file of pr.querySelectorAll(".file")) {
          await wait(380);
          file.classList.add("on");
        }
        await wait(5200);
      },
      async share() {
        await wait(1500);
        // Assign it to the client.
        await press($(".assign-button"), "assigning", { ms: 900 });
        await wait(600);
        const email = $(".assign-menu input");
        await move(email, 0.3, 0.5, 600);
        await click();
        await type(email, "sam@client.co", $('.assign-menu button[type="submit"]'));
        show("typed");
        await wait(300);
        await press($('.assign-menu button[type="submit"]'), "assigned", { ms: 500, pause: 100 });
        await wait(2200);
        // The home page: it's waiting on them, until their answers come back.
        await fade(true);
        show("home");
        doc.body.classList.remove("demo-out");
        place(1100, 700, 0);
        await wait(2300);
        show("back");
        const row = byText(".home-row", "Launch details");
        if (row) flash([row]);
        await wait(2400);
        await press(byText(".home-row", "Launch details"), null, { ms: 900 });
        await fade(true);
        show("answers");
        doc.body.classList.remove("demo-out");
        await wait(4200);
      },
    };

    // The last state, still: for reduced motion.
    const stillOf = (name) => {
      const states = statesOf(name);
      const last = template(name, states[states.length - 1]).content.firstElementChild.cloneNode(true);
      hydrate(last);
      root.replaceChildren(last);
      urlBar.textContent = urlOf(states[states.length - 1]);
      cursor.hidden = true;
      pr.classList.remove("on");
      if (name === "ship") {
        drawPr();
        pr.querySelectorAll(".file").forEach((f) => f.classList.add("on"));
        pr.classList.add("on");
      }
    };

    run = async (index) => {
      const mine = ++gen;
      story = names[index];
      played = 0;
      if (still) return stillOf(story);
      try {
        await enter();
        await PLAYS[story]();
        if (new URLSearchParams(location.search).has("demo-debug")) console.log("demo", story, Math.round(played), "ms of", STORIES[story].ms);
        tabs[index].style.setProperty("--progress", "1");
        if (mine === gen) select((index + 1) % tabs.length);
      } catch (error) {
        if (error !== ABORT) console.error(error);
      }
    };
  }
})();
