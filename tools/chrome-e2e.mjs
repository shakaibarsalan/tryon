// End-to-end check in real Chrome: the unpacked extension in a separate test profile, live store
// product pages, the extension's own "Try on" chip, the side panel, the Try-On API and whichever
// provider it runs (start it with PROVIDER=self-hosted and vton-server for real renders).
//
//   node tools/chrome-e2e.mjs [--stores tools/e2e-stores.json] [--only "Outfitters,Gymshark"]
//        [--person extension/dev/samples/model.jpg] [--out eval/out/e2e] [--record] [--keep-open]
//
// Needs: Google Chrome, `npm run build -w extension` (dist/), the API on http://localhost:8787 with
// enough free renders (e.g. --var FREE_RENDERS_PER_INSTALL:50). Chrome runs with its own profile in
// ~/.cache/tryon-e2e/profile, never your everyday one.
//
// One test-only difference: DevTools can't click Chrome's toolbar button or context menu, which is
// what grants the extension activeTab on a page. The copy of dist/ this script loads also asks for
// https://*/* host access instead. Everything after that is the extension's normal code.
//
// --record saves DevTools screencast frames of the store tab and the side panel to <out>/frames/
// (see tools/make-clip.py), for a demo clip.
//
// Live mirror: --camera <file.y4m> feeds a video file to Chrome as the webcam (make one from an
// AI-generated photo with tools/fake-camera.py) and --mirror opens the live mirror on each picked
// garment. The first time, the mirror opens in a tab (the side panel can't show Chrome's camera
// prompt); the script then allows the camera for the extension, as a person would, and checks the
// mirror inside the side panel. With --mirror, "Make it real" starts the AI try-on from the live frame;
// the mirror then wears that render, and the script saves a few frames of it (-mirror-fitted-N.jpg).
//
// Speed: --mirror-ms 20000 keeps the mirror running for 20 s while the script samples its frame
// rate, body-tracking rate and speed step. --cpu-throttle 4 slows the side panel's own thread four
// times over (what Lighthouse uses to stand in for a mid-range phone); Chrome can't slow the mirror's
// workers this way, so it shows whether the page keeps up, not how a slow device tracks. --profile
// <dir> runs a second Chrome with its own profile and copy of the extension, next to an open one.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const base = join(homedir(), ".cache", "tryon-e2e");
const profile = opt("profile", join(base, "profile"));
const extCopy = opt("profile") ? `${profile}-extension` : join(base, "extension");
const storesFile = resolve(opt("stores", join(repo, "tools", "e2e-stores.json")));
const person = resolve(opt("person", join(repo, "extension", "dev", "samples", "model.jpg")));
const outDir = resolve(opt("out", join(repo, "eval", "out", "e2e")));
const only = opt("only", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const record = flag("record");
const camera = opt("camera", "");
const mirrorOnly = flag("mirror-only");
// Stop once the garment is in the fitting room and hand the window to a person (use with --keep-open).
const setupOnly = flag("setup-only");
const mirrorMode = flag("mirror") || mirrorOnly;
const RENDER_TIMEOUT_MS = Number(opt("render-timeout", "900")) * 1000;
const cpuThrottle = Number(opt("cpu-throttle", "1"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------------------------------------
// DevTools protocol over --remote-debugging-pipe (NUL-separated JSON on fds 3 and 4).

class Cdp {
  constructor(proc) {
    this.out = proc.stdio[3];
    this.pending = new Map();
    this.listeners = new Set();
    this.id = 0;
    let buf = Buffer.alloc(0);
    proc.stdio[4].on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) >= 0) {
        const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
        buf = buf.subarray(i + 1);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: ok, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
          else ok(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((ok, reject) => {
      this.pending.set(id, { resolve: ok, reject });
      this.out.write(JSON.stringify(msg) + "\0");
    });
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  waitFor(pred, timeoutMs, what) {
    return new Promise((ok, reject) => {
      const off = this.on((m) => {
        if (pred(m)) {
          clearTimeout(t);
          off();
          ok(m);
        }
      });
      const t = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
    });
  }
}

async function evaluate(cdp, sessionId, expression, { gesture = false } = {}) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: gesture }, sessionId);
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result?.value;
}

async function waitUntil(fn, timeoutMs, what, every = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

async function click(cdp, sessionId, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
}

/** The extension's chips: inside the closed shadow root of <xb-tryon-layer>, best candidate first. */
async function visibleChips(cdp, sessionId) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
  let layer;
  const walk = (n) => {
    if (layer) return;
    if (n.nodeName === "XB-TRYON-LAYER") layer = n;
    for (const c of n.children ?? []) walk(c);
    for (const s of n.shadowRoots ?? []) walk(s);
  };
  walk(root);
  const shadow = layer?.shadowRoots?.[0];
  const chips = (shadow?.children ?? []).filter((c) => c.nodeName === "BUTTON" && (c.attributes ?? []).join(" ").includes("chip"));
  const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
  const vw = metrics.cssVisualViewport.clientWidth;
  const vh = metrics.cssVisualViewport.clientHeight;
  const out = [];
  out.total = chips.length;
  out.details = [];
  for (const c of chips) {
    const attrs = c.attributes ?? [];
    if (attrs.includes("hidden")) {
      out.details.push({ hidden: true, covered: attrs[attrs.indexOf("data-covered") + 1] });
      continue;
    }
    try {
      const { model } = await cdp.send("DOM.getBoxModel", { nodeId: c.nodeId }, sessionId);
      const q = model.border;
      const x = (q[0] + q[2]) / 2;
      const y = (q[1] + q[5]) / 2;
      out.details.push({ x: Math.round(x), y: Math.round(y) });
      if (x > 0 && y > 0 && x < vw && y < vh) out.push({ x, y });
    } catch {
      out.details.push({ unlaid: true });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Screencast frames (for the demo clip)

function startRecording(cdp, sessions) {
  const dir = join(outDir, "frames");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const index = [];
  const off = cdp.on((m) => {
    if (m.method !== "Page.screencastFrame") return;
    const name = Object.entries(sessions).find(([, s]) => s === m.sessionId)?.[0];
    if (!name) return;
    const file = `${name}-${String(index.length).padStart(5, "0")}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(m.params.data, "base64"));
    index.push({ source: name, file, t: m.params.metadata.timestamp });
    void cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
  });
  return {
    async start() {
      for (const s of Object.values(sessions)) {
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 }, s);
      }
    },
    mark(label) {
      index.push({ source: "mark", label, t: Date.now() / 1000 });
    },
    async stop() {
      for (const s of Object.values(sessions)) await cdp.send("Page.stopScreencast", {}, s).catch(() => {});
      off();
      writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 1));
      log(`recorded ${index.length} frames in ${dir}`);
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Debug channel for a person testing in the window (--keep-open --control <port>): lists targets,
// evaluates JavaScript in a target found by URL, and keeps the last console messages and errors of
// every page, including tabs opened later (like the live mirror tab). Listens on 127.0.0.1 only.

async function startControl(cdp, port) {
  const logs = [];
  const urls = new Map();
  const add = (sessionId, type, text) => {
    logs.push({ t: new Date().toISOString().slice(11, 19), page: urls.get(sessionId) ?? "?", type, text: String(text).slice(0, 800) });
    if (logs.length > 400) logs.shift();
  };
  cdp.on((m) => {
    if (m.method === "Target.attachedToTarget") {
      urls.set(m.params.sessionId, m.params.targetInfo.url.replace(/^chrome-extension:\/\/[a-p]+/, "ext"));
      void cdp.send("Runtime.enable", {}, m.params.sessionId).catch(() => {});
      void cdp.send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {});
    } else if (m.method === "Runtime.consoleAPICalled") {
      add(m.sessionId, m.params.type, m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      add(m.sessionId, "exception", d.exception?.description ?? d.text);
    }
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const sessions = new Map();
  const attach = async (match) => {
    const t = (await cdp.send("Target.getTargets")).targetInfos.find((x) => x.type !== "browser" && x.url.includes(match));
    if (!t) throw new Error(`no page matching ${match}`);
    if (!sessions.has(t.targetId)) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      urls.set(sessionId, t.url.replace(/^chrome-extension:\/\/[a-p]+/, "ext"));
      await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
      sessions.set(t.targetId, sessionId);
    }
    return sessions.get(t.targetId);
  };
  createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      let out;
      if (u.pathname === "/targets") out = (await cdp.send("Target.getTargets")).targetInfos.map((t) => ({ type: t.type, url: t.url }));
      else if (u.pathname === "/eval") out = await evaluate(cdp, await attach(u.searchParams.get("target") ?? ""), body);
      else if (u.pathname === "/logs") out = logs.slice(-Number(u.searchParams.get("n") ?? 60));
      else throw new Error("use /targets, /eval?target=<url part> (POST the JavaScript) or /logs");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out, null, 1));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  }).listen(port, "127.0.0.1");
  log(`debug channel on http://127.0.0.1:${port}`);
}

async function main() {
  const dist = join(repo, "extension", "dist");
  if (!existsSync(join(dist, "manifest.json"))) throw new Error("Build the extension first: npm run build -w extension");
  const stores = JSON.parse(readFileSync(storesFile, "utf8")).filter((s) => !only.length || only.includes(s.name.toLowerCase()));
  mkdirSync(outDir, { recursive: true });
  mkdirSync(profile, { recursive: true });

  // Test copy of the extension with host access (see the note at the top).
  rmSync(extCopy, { recursive: true, force: true });
  cpSync(dist, extCopy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extCopy, "manifest.json"), "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), "https://*/*", "http://localhost/*"])];
  writeFileSync(join(extCopy, "manifest.json"), JSON.stringify(manifest, null, 2));

  const proc = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--window-size=1480,940",
      // Keep rendering when the window is behind others (Chrome otherwise pauses hidden pages, which
      // stops the camera frames and image decoding), so a run works while the Mac is in use.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--lang=en-US",
      ...(camera
        ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${resolve(camera)}`]
        : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  proc.stderr.on("data", () => {});
  const cdp = new Cdp(proc);
  const results = [];
  try {
    const { product } = await cdp.send("Browser.getVersion");
    const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: extCopy });
    log(`${product}, extension ${extId}`);
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    const targets = async () => (await cdp.send("Target.getTargets")).targetInfos;
    const pageTarget = (await targets()).find((t) => t.type === "page" && t.url === "about:blank");
    const { sessionId: page } = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
    await cdp.send("Page.enable", {}, page);
    await cdp.send("Runtime.enable", {}, page);

    // Open the side panel with a real click on an extension page (sidePanel.open needs a user gesture).
    const opener = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/privacy.html` });
    const { sessionId: openerS } = await cdp.send("Target.attachToTarget", { targetId: opener.targetId, flatten: true });
    await waitUntil(() => evaluate(cdp, openerS, "document.readyState === 'complete' && !!chrome.sidePanel"), 10_000, "opener page");
    await evaluate(
      cdp,
      openerS,
      `window.__open = new Promise((ok) => document.addEventListener("click", () => {
         chrome.windows.getCurrent().then((w) => chrome.sidePanel.open({ windowId: w.id })).then(() => ok("opened"), (e) => ok(String(e)));
       }, { once: true })); true`,
    );
    await click(cdp, openerS, 40, 40);
    const opened = await evaluate(cdp, openerS, "window.__open");
    log(`side panel: ${opened}`);
    const panelTarget = await waitUntil(
      async () => (await targets()).find((t) => t.url.startsWith(`chrome-extension://${extId}/sidepanel.html`)),
      10_000,
      "side panel target",
    );
    await cdp.send("Target.closeTarget", { targetId: opener.targetId });
    await cdp.send("Target.activateTarget", { targetId: pageTarget.targetId });
    const { sessionId: panel } = await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, panel);
    await cdp.send("Page.enable", {}, panel).catch(() => {});
    const inPanel = (js) => evaluate(cdp, panel, js);
    if (cpuThrottle > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle }, panel);
      log(`side panel CPU slowed ${cpuThrottle}x`);
    }
    const shown = (id) => inPanel(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && !e.hidden && e.offsetParent !== null; })()`);

    // Consent and the photo (an AI-generated model photo, never a real person's).
    await waitUntil(() => inPanel("document.readyState === 'complete'"), 10_000, "panel load");
    await sleep(800);
    if (await shown("screen-consent")) {
      await inPanel(`document.querySelectorAll('#consent-form input[type=checkbox]').forEach((b) => b.checked || b.click());
                     document.getElementById('consent-accept').click(); true`);
      log("consent given");
    }
    await sleep(800);
    if (await shown("screen-photo")) {
      if (await shown("photo-empty")) {
        const { root } = await cdp.send("DOM.getDocument", { depth: 1 }, panel);
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#photo-file" }, panel);
        await cdp.send("DOM.setFileInputFiles", { files: [person], nodeId }, panel);
        await waitUntil(() => shown("photo-saved"), 20_000, "photo saved");
        log("photo added");
      }
      await inPanel("document.getElementById('photo-continue').click(); true");
    }
    await waitUntil(() => shown("screen-room"), 10_000, "fitting room");

    let recorder;
    if (record) {
      recorder = startRecording(cdp, { store: page, panel });
      await recorder.start();
    }

    for (const store of stores) {
      const r = { store: store.name, country: store.country, url: store.productUrl, started: new Date().toISOString() };
      results.push(r);
      log(`--- ${store.name}: ${store.productUrl}`);
      try {
        recorder?.mark(`store:${store.name}`);
        // Clear the previous store's result so it isn't mistaken for this one.
        await inPanel("(() => { if (!document.getElementById('result').hidden) document.getElementById('result-close').click(); return true; })()");
        const loaded = cdp.waitFor((m) => m.sessionId === page && m.method === "Page.loadEventFired", 45_000, "page load").catch(() => null);
        await cdp.send("Page.navigate", { url: store.productUrl }, page);
        await loaded;
        await sleep(Number(store.settleMs ?? 4000));
        r.pageTitle = await evaluate(cdp, page, "document.title").catch(() => "");

        // The panel puts chips on the page when the tab finishes loading; give it a moment.
        let chips = await waitUntil(async () => {
          const c = await visibleChips(cdp, page);
          return c.length ? c : undefined;
        }, 20_000, "Try on chips").catch(() => []);
        if (!chips.length) {
          // Like a person flipping the "Try-On buttons" switch off and on in the panel.
          await inPanel("(() => { const t = document.getElementById('chips-toggle'); t.click(); t.click(); return true; })()");
          await evaluate(cdp, page, "window.scrollTo(0, 0); true");
          chips = await waitUntil(async () => {
            const c = await visibleChips(cdp, page);
            return c.length ? c : undefined;
          }, 15_000, "Try on chips").catch(() => []);
        }
        r.chips = chips.length;
        if (!chips.length && flag("debug")) {
          const diag = await evaluate(cdp, page, `JSON.stringify([...document.images].map((i) => ({ i, r: i.getBoundingClientRect() }))
            .filter((x) => x.r.width > 120 && x.r.height > 120).slice(0, 4).map(({ i, r }) => {
              const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
              return { src: (i.currentSrc || i.src).slice(-50), r: [r.left, r.top, r.width, r.height].map(Math.round), vw: innerWidth,
                stack: document.elementsFromPoint(cx, cy).slice(0, 5).map((e) => e.tagName + "." + String(e.className).slice(0, 30)) };
            }))`).catch((e) => String(e));
          log(`debug: ${diag}`);
        }
        if (!chips.length) {
          const all = await visibleChips(cdp, page).catch(() => []);
          throw new Error(`no Try on chip on screen (${all.total ?? 0} chips in the page: ${JSON.stringify(all.details ?? []).slice(0, 400)})`);
        }
        // Like a shopper: the chip on the biggest product photo (the main one), unless the store sets one.
        const areas = await evaluate(
          cdp,
          page,
          `JSON.stringify(${JSON.stringify(chips)}.map((c) => {
            const img = document.elementsFromPoint(c.x + 40, c.y + 40).find((e) => e.tagName === "IMG");
            const r = img ? img.getBoundingClientRect() : null;
            return r ? r.width * r.height : 0;
          }))`,
        ).then((s) => JSON.parse(s)).catch(() => chips.map(() => 0));
        const biggest = areas.indexOf(Math.max(...areas));
        const chip = store.chip !== undefined ? chips[Math.min(Number(store.chip), chips.length - 1)] : chips[Math.max(0, biggest)];
        const before = await inPanel("document.getElementById('garment-img').getAttribute('src') || ''");
        await click(cdp, page, chip.x, chip.y);
        log(`clicked chip at ${Math.round(chip.x)},${Math.round(chip.y)} (${chips.length} chips)`);

        // Wait for this garment, not the previous store's card still on screen.
        await waitUntil(
          async () =>
            (await shown("garment-card")) &&
            !(await shown("garment-loading")) &&
            ((await inPanel("document.getElementById('garment-img').getAttribute('src') || ''")) !== before || (await shown("garment-error"))),
          90_000,
          "this garment loaded",
        );
        Object.assign(
          r,
          await inPanel(`({
            garmentTitle: document.getElementById('garment-title').textContent,
            garmentSite: document.getElementById('garment-site').textContent,
            category: document.getElementById('garment-category').value,
            note: document.getElementById('garment-note').hidden ? '' : document.getElementById('garment-note').textContent,
            garmentError: document.getElementById('garment-error').hidden ? '' : document.getElementById('garment-error').textContent,
            garmentImage: document.getElementById('garment-img').src.slice(0, 40),
          })`),
        );
        if (store.category) await inPanel(`(() => { const s = document.getElementById('garment-category'); s.value = ${JSON.stringify(store.category)}; s.dispatchEvent(new Event('change')); return true; })()`);
        r.categoryUsed = await inPanel("document.getElementById('garment-category').value");
        if (r.garmentError) throw new Error(`garment failed: ${r.garmentError}`);
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, page).then((s) =>
          writeFileSync(join(outDir, `${slug(store.name)}-page.jpg`), Buffer.from(s.data, "base64")),
        );

        if (setupOnly) {
          r.status = "ready";
          log(`${store.name}: garment ready in the fitting room; the window is yours`);
          continue;
        }
        let t0 = Date.now();
        if (mirrorMode) {
          // Live mirror: the first time it opens in a tab, which can ask for the camera.
          recorder?.mark(`mirror:${store.name}`);
          if (flag("mirror-debug")) await inPanel("location.hash = 'mirror-debug'; true");
          // Developer timings, and the garment cut-out kept for saving below.
          if (flag("mirror-profile")) await inPanel("location.hash = 'mirror-profile'; true");
          await inPanel("document.getElementById('mirror-btn').click(); true");
          await sleep(2000);
          const mirrorStatus = (s) => evaluate(cdp, s, "document.getElementById('mirror-status')?.textContent || ''");
          const tracking = (text) => (/follows you/.test(text) ? text : undefined);
          const tab = (await targets()).find((t) => t.url.startsWith(`chrome-extension://${extId}/mirror.html`));
          if (tab) {
            const { sessionId: ms } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
            await cdp.send("Runtime.enable", {}, ms);
            await cdp.send("Page.enable", {}, ms);
            if (cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle }, ms);
            const t1 = Date.now();
            r.mirrorTab = await waitUntil(async () => tracking(await mirrorStatus(ms)), 90_000, "mirror tracking in its tab", 500);
            r.mirrorTabSeconds = Math.round((Date.now() - t1) / 1000);
            await sleep(1500);
            await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }, ms).then((s) =>
              writeFileSync(join(outDir, `${slug(store.name)}-mirror-tab.jpg`), Buffer.from(s.data, "base64")),
            );
            await cdp.send("Target.closeTarget", { targetId: tab.targetId });
            await cdp.send("Target.activateTarget", { targetId: pageTarget.targetId });
            // The person clicked Allow in that tab; from now on the side panel can use the camera.
            await cdp.send("Browser.grantPermissions", { origin: `chrome-extension://${extId}`, permissions: ["videoCapture"] });
            await inPanel("document.getElementById('mirror-btn').click(); true");
          }
          const t2 = Date.now();
          let lastStatus = "";
          r.mirrorPanel = await waitUntil(
            async () => {
              lastStatus = await inPanel("document.getElementById('mirror').hidden ? '(mirror closed)' : document.getElementById('mirror-status').textContent");
              return tracking(lastStatus);
            },
            90_000,
            "mirror tracking in the side panel",
            500,
          ).catch((e) => {
            throw new Error(`${e.message}; the mirror said: ${lastStatus}`);
          });
          r.mirrorPanelSeconds = Math.round((Date.now() - t2) / 1000);
          // The dev build shows "<n> fps · body <b>/s · step <k>" on the mirror: frames drawn, body-tracking
          // answers and the speed step. Sample it while the mirror runs.
          const fps = [];
          const body = [];
          let step = 0;
          for (const end = Date.now() + Number(opt("mirror-ms", "4000")); Date.now() < end; ) {
            await sleep(1000);
            const m = /(\d+) fps(?: · body (\d+)\/s)?(?: · step (\d+))?/.exec(await inPanel("document.getElementById('mirror-fps')?.textContent || ''"));
            if (m) {
              fps.push(Number(m[1]));
              if (m[2] !== undefined) body.push(Number(m[2]));
              step = Number(m[3] ?? 0);
            }
          }
          const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
          if (fps.length) {
            r.mirrorFps = { fps: median(fps), body: body.length ? median(body) : undefined, samples: fps, bodySamples: body, lastStep: step, cpuThrottle };
            log(`${store.name}: mirror ${r.mirrorFps.fps} fps, body tracked ${r.mirrorFps.body ?? "?"}/s (medians), speed step ${step}${cpuThrottle > 1 ? `, CPU slowed ${cpuThrottle}x` : ""}`);
          }
          await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }, panel).then((s) =>
            writeFileSync(join(outDir, `${slug(store.name)}-mirror-panel.jpg`), Buffer.from(s.data, "base64")),
          );
          log(`${store.name}: live mirror tracking (${tab ? "tab, then " : ""}side panel)`);
          // A few frames over time, to see the garment move with the body.
          for (let i = 1; i <= 4; i++) {
            await sleep(900);
            const data = await inPanel("document.getElementById('mirror-canvas').toDataURL('image/jpeg', 0.85)");
            writeFileSync(join(outDir, `${slug(store.name)}-mirror-${i}.jpg`), Buffer.from(data.split(",")[1], "base64"));
          }
          if (mirrorOnly) {
            r.status = "mirror";
            await inPanel("document.getElementById('mirror-close').click(); true");
            continue;
          }
          recorder?.mark(`try:${store.name}`);
          t0 = Date.now();
          await inPanel("document.getElementById('mirror-real').click(); true");
        } else {
          recorder?.mark(`try:${store.name}`);
          await waitUntil(() => inPanel("!document.getElementById('try-btn').disabled"), 45_000, "Try it on enabled");
          await inPanel("document.getElementById('try-btn').click(); true");
        }
        const progress = new Set();
        const outcome = await waitUntil(
          async () => {
            const p = await inPanel("document.getElementById('progress').hidden ? '' : document.getElementById('progress-text').textContent");
            if (p) progress.add(p.replace(/\s\d+:\d+$/, ""));
            if (await shown("result")) return "result";
            if (await shown("try-error")) return "error";
            return undefined;
          },
          RENDER_TIMEOUT_MS,
          "render",
          1000,
        );
        r.seconds = Math.round((Date.now() - t0) / 1000);
        r.progress = [...progress];
        if (outcome === "error") {
          r.status = "error";
          r.error = await inPanel("document.getElementById('try-error').innerText");
        } else {
          r.status = "rendered";
          const src = await inPanel("document.getElementById('result-img').src");
          const m = /^data:image\/(\w+);base64,(.*)$/.exec(src);
          if (m) writeFileSync(join(outDir, `${slug(store.name)}-result.${m[1] === "jpeg" ? "jpg" : m[1]}`), Buffer.from(m[2], "base64"));
          if (mirrorMode && !(await inPanel("document.getElementById('mirror').hidden"))) {
            // The mirror stays open and switches to the AI render of the person: a few frames of that.
            const fitted = await waitUntil(
              async () => ((await inPanel("document.body.innerText.includes('now shows the AI version')")) ? true : undefined),
              90_000,
              "mirror wearing the AI render",
              500,
            ).catch(() => "");
            r.mirrorFitted = !!fitted;
            await sleep(2500);
            const png = flag("mirror-profile") ? await inPanel("globalThis.__mirrorGarment || ''") : "";
            if (png) writeFileSync(join(outDir, `${slug(store.name)}-fitted-cutout.png`), Buffer.from(png.split(",")[1], "base64"));
            for (let i = 1; i <= 4; i++) {
              const data = await inPanel("document.getElementById('mirror-canvas').toDataURL('image/jpeg', 0.85)");
              writeFileSync(join(outDir, `${slug(store.name)}-mirror-fitted-${i}.jpg`), Buffer.from(data.split(",")[1], "base64"));
              await sleep(900);
            }
            log(`${store.name}: mirror ${fitted ? "wearing the AI render" : "did not switch to the AI render"}`);
          }
        }
        recorder?.mark(`done:${store.name}`);
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }, panel).then(
          (s) => writeFileSync(join(outDir, `${slug(store.name)}-panel.jpg`), Buffer.from(s.data, "base64")),
          () => {},
        );
        log(`${store.name}: ${r.status} in ${r.seconds}s ${r.error ?? ""}`);
        await sleep(2500);
      } catch (e) {
        r.status = r.status ?? "failed";
        r.error = r.error ?? String(e.message ?? e);
        log(`${store.name}: FAILED ${r.error}`);
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, page).then(
          (s) => writeFileSync(join(outDir, `${slug(store.name)}-failed.jpg`), Buffer.from(s.data, "base64")),
          () => {},
        );
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, panel).then(
          (s) => writeFileSync(join(outDir, `${slug(store.name)}-panel-failed.jpg`), Buffer.from(s.data, "base64")),
          () => {},
        );
      }
      writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
    }
    await recorder?.stop();
  } finally {
    writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
    if (flag("keep-open")) {
      const port = Number(opt("control", "0"));
      if (port) await startControl(cdp, port);
      log("leaving Chrome open (Ctrl+C to quit)");
      await new Promise(() => {});
    }
    await cdp.send("Browser.close").catch(() => {});
    setTimeout(() => proc.kill(), 1500).unref();
  }
  const ok = results.filter((r) => r.status === "rendered").length;
  log(`done: ${ok} of ${results.length} stores rendered; results in ${outDir}`);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
