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
import { spawn } from "node:child_process";
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
const extCopy = join(base, "extension");
const storesFile = resolve(opt("stores", join(repo, "tools", "e2e-stores.json")));
const person = resolve(opt("person", join(repo, "extension", "dev", "samples", "model.jpg")));
const outDir = resolve(opt("out", join(repo, "eval", "out", "e2e")));
const only = opt("only", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const record = flag("record");
const RENDER_TIMEOUT_MS = Number(opt("render-timeout", "900")) * 1000;

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
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), "https://*/*"])];
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
      "--lang=en-US",
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
          await evaluate(cdp, page, "window.scrollTo(0, 0); true");
          await sleep(1500);
          chips = await visibleChips(cdp, page);
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
        const chip = chips[Math.min(Number(store.chip ?? 0), chips.length - 1)];
        await click(cdp, page, chip.x, chip.y);
        log(`clicked chip at ${Math.round(chip.x)},${Math.round(chip.y)} (${chips.length} chips)`);

        await waitUntil(async () => (await shown("garment-card")) && !(await shown("garment-loading")), 60_000, "garment loaded");
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

        recorder?.mark(`try:${store.name}`);
        const t0 = Date.now();
        await waitUntil(() => inPanel("!document.getElementById('try-btn').disabled"), 15_000, "Try it on enabled");
        await inPanel("document.getElementById('try-btn').click(); true");
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
        }
        recorder?.mark(`done:${store.name}`);
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
      }
      writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
    }
    await recorder?.stop();
  } finally {
    writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
    if (flag("keep-open")) {
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
