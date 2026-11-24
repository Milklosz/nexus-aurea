// Run with `node scripts/home-layout-browser-check.mjs` on Windows with Edge.
// Pass `--css-ref <git-ref>` to apply the same geometry assertions to an older style sheet.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const theme = "src/theme/living-room/";
const services = ["Netflix", "Disney+", "HBO Max", "Prime Video", "YouTube", "Steam", "Playnite", "Apple Music"];
const viewports = [[1920, 1080], [3840, 2160], [2560, 1440], [780, 650]];
const states = ["empty", "populated", "error-with-long-copy"];

async function findEdge() {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  const candidates = [process.env.VELORA_EDGE_EXECUTABLE, ...roots.filter(Boolean).map((root) =>
    join(root, "Microsoft", "Edge", "Application", "msedge.exe"))];
  for (const candidate of candidates.filter(Boolean)) {
    if (await stat(candidate).then((info) => info.isFile(), () => false)) return candidate;
  }
  throw new Error("Microsoft Edge was not found. Set VELORA_EDGE_EXECUTABLE to its executable path.");
}

function populatedSections() {
  const row = (heading, names, continuing) => `<div class="lr-section">
    <h2 class="lr-section-title">${heading}</h2><div class="lr-section-tiles" role="group">
    ${names.map((name) => `<button type="button" class="lr-section-tile" data-lr-section-tile>
      <span class="lr-section-name">${name}</span>${continuing ? '<span class="lr-section-badge">Kontynuuj</span>' : ""}
    </button>`).join("")}</div></div>`;
  return `<section class="lr-sections">${row("Kontynuuj", ["Netflix"], true)}${row("Ostatnio używane", services, false)}</section>`;
}

// Mirrors the Home component structure. CSS always comes from the repository.
function fixture(state) {
  const long = state === "error-with-long-copy";
  const title = long ? "DodatkowaOfertaDlaPosiadaczyTelewizorówPanoramicznych" : "Netflix";
  const context = long ? "Ta usługa wymaga ponownego połączenia. Sprawdź połączenie i spróbuj ponownie z poziomu wybranej aplikacji." : "Filmy i seriale";
  let sections = `<p class="lr-sections-state lr-sections-empty">Tutaj pojawią się ostatnio otwierane aplikacje.</p>`;
  if (state === "populated") sections = populatedSections();
  if (long) sections = `<div class="lr-sections lr-sections-state lr-sections-error" role="alert">
    <p class="lr-sections-error-text">Nie udało się odczytać stanu sesji. Otwórz ponownie aplikację lub spróbuj przywrócić połączenie.</p>
    <button type="button" class="lr-sections-retry">Spróbuj ponownie</button></div>`;
  return `<main class="lr"><header class="lr-top">
    <div class="lr-when"><time class="lr-clock">20:06</time><span class="lr-weather"><b>−12°</b>Pochmurno</span></div>
    <nav class="home-actions lr-actions"><section class="claude-usage" aria-label="Claude Usage">
      <button class="lr-action claude-usage-trigger" type="button" aria-expanded="false"><span>Claude Usage</span><small>Niedostępne</small></button>
    </section>${["Szukaj", "Pilot", "Ustawienia"].map((label) =>
      `<button class="lr-action" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /></svg>${label}</button>`).join("")}</nav></header>
    <div class="lr-home-content">
      <section class="lr-info"><h1 class="lr-title">${title}</h1><p class="lr-context"><span>${context}</span></p></section>
      ${sections}
      <nav class="lr-dock">${services.map((name, index) => `<button type="button" class="lr-tile${index === 0 ? " is-focused" : ""}" aria-label="Otwórz ${name}">
        <span class="lr-wordmark"><i>${name}</i></span><span class="lr-bar" aria-hidden="true"></span></button>`).join("")}</nav>
    </div></main>`;
}

async function runGeometryCases(css, cases) {
  const results = [];
  const tolerance = 1;
  const frame = document.body.appendChild(document.createElement("iframe"));
  frame.style.cssText = "display:block;border:0;";
  const inBounds = (box, bounds) => box.width > 0 && box.height > 0 &&
    box.left >= bounds.left - tolerance && box.top >= bounds.top - tolerance &&
    box.right <= bounds.right + tolerance && box.bottom <= bounds.bottom + tolerance;

  for (const { width, height, state, markup } of cases) {
    const errors = [];
    const check = (passed, message) => { if (!passed) errors.push(message); };
    frame.width = width;
    frame.height = height;
    await new Promise((resolve) => {
      frame.onload = resolve;
      // Inspect the settled focus geometry without waiting through each animation.
      frame.srcdoc = `<!doctype html><html lang="pl" class="lr-theme"><meta charset="utf-8"><style>${css}
        .lr :is(.lr-action, .lr-section-tile, .lr-tile) { transition-duration: 0s; }
      </style>${markup}</html>`;
    });
    const doc = frame.contentDocument;
    const select = (selector) => doc.querySelector(selector);
    const rect = (selector) => select(selector).getBoundingClientRect();
    const bounds = { left: 0, top: 0, right: width, bottom: height };
    const info = rect(".lr-info");
    const sections = rect(".lr-sections, .lr-sections-state");
    const dock = rect(".lr-dock");
    const top = rect(".lr-top");
    const title = rect(".lr-title");
    const context = rect(".lr-context");
    check(frame.contentWindow.innerWidth === width && frame.contentWindow.innerHeight === height, "Unexpected CSS viewport");
    check(frame.contentWindow.getComputedStyle(select(".lr-title")).fontFamily.includes("Segoe UI"), "Living Room typography did not load");
    for (const [label, box] of Object.entries({ top, info, title, context, sections, dock })) {
      check(inBounds(box, bounds), `${label} is outside the viewport`);
    }
    check(rect(".lr-when").right <= rect(".lr-actions").left + tolerance, "clock/weather overlaps system actions");
    check(top.bottom <= info.top + tolerance, "top bar overlaps the title area");
    check(title.bottom <= context.top + tolerance, "title overlaps its context");
    check(info.bottom <= sections.top + tolerance, "title/context overlaps Home sections");
    check(sections.bottom <= dock.top + tolerance, "Home sections overlap the dock");
    for (const selector of [".lr-title", ".lr-context", ".lr-sections-error-text"]) {
      const element = select(selector);
      if (!element) continue;
      const text = doc.createRange();
      text.selectNodeContents(element);
      check([...text.getClientRects()].every((line) => line.left >= -tolerance && line.right <= width + tolerance), `${selector} text overflows horizontally`);
    }

    const buttons = [...doc.querySelectorAll(".lr-action, .lr-tile, .lr-section-tile, .lr-sections-retry")];
    let marked = select(".lr-tile.is-focused");
    for (const button of buttons) {
      const label = button.getAttribute("aria-label") ?? button.textContent.trim();
      marked?.classList.remove("is-focused");
      marked = button.matches(".lr-tile, .lr-action:not(.claude-usage-trigger)") ? button : null;
      marked?.classList.add("is-focused");
      button.focus({ preventScroll: true });
      check(doc.activeElement === button, `${label} cannot receive focus`);
      const box = button.getBoundingClientRect();
      check(inBounds(box, bounds), `${label} has an out-of-bounds target`);
      const row = button.closest(".lr-section-tiles");
      if (row && frame.contentWindow.getComputedStyle(row).overflow !== "visible") {
        check(inBounds(box, row.getBoundingClientRect()), `${label} is clipped in the sections row`);
      }
      if (button.matches(".lr-tile")) check(box.top >= sections.bottom - tolerance, `${label} overlaps Home sections on focus`);
      const center = doc.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      check(button.contains(center), `${label} is obscured at its center`);
    }
    results.push({ viewport: `${width}x${height}`, state, errors });
  }
  frame.remove();
  const summary = document.createElement("script");
  summary.type = "application/json";
  summary.id = "home-geometry-results";
  summary.textContent = JSON.stringify(results);
  document.body.appendChild(summary);
}

async function main() {
  const [flag, ref, ...rest] = process.argv.slice(2);
  assert.ok(!flag || (flag === "--css-ref" && ref && !ref.startsWith("-") && !rest.length),
    "Usage: node scripts/home-layout-browser-check.mjs [--css-ref <git-ref>]");
  const readCss = (name) => ref
    ? execute("git", ["show", `${ref}:${name}`], { cwd: repository }).then(({ stdout }) => stdout)
    : readFile(join(repository, name), "utf8");
  const [edge, ...styles] = await Promise.all([
    findEdge(), ...["src/styles.css", `${theme}tokens.css`, `${theme}overlays.css`, `${theme}livingRoom.css`].map(readCss),
  ]);
  const css = styles.join("\n").replace(/^@import .*;\r?\n/gm, "");
  const cases = viewports.flatMap(([width, height]) => states.map((state) => ({ width, height, state, markup: fixture(state) })));
  const payload = JSON.stringify([css, cases]).replaceAll("<", "\\u003c");
  const scratchRoot = await realpath(tmpdir());
  const scratch = await mkdtemp(join(scratchRoot, "velora-home-layout-"));
  try {
    const page = join(scratch, "home-layout.html");
    await writeFile(page, `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
      (${runGeometryCases})(...${payload}).catch((error) => { document.body.dataset.probeError = String(error); });
    </script>`, "utf8");
    const { stdout } = await execute(edge, [
      "--headless=new", "--disable-background-networking", "--disable-component-update", "--no-first-run",
      "--force-device-scale-factor=1", "--window-size=4000,2320", "--virtual-time-budget=4000", "--dump-dom",
      `--user-data-dir=${join(scratch, "profile")}`, pathToFileURL(page).href,
    ], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const result = stdout.match(/<script type="application\/json" id="home-geometry-results">([^<]*)<\/script>/)?.[1];
    assert.ok(result, `Edge did not complete the Home geometry probe. ${stdout.match(/data-probe-error="([^"]*)"/)?.[1] ?? ""}`);
    const results = JSON.parse(result);
    assert.equal(results.length, cases.length);
    for (const { viewport, state, errors } of results) {
      console.log(`${viewport} ${state}: ${errors.length ? errors.join("; ") : "PASS"}`);
    }
    if (results.some(({ errors }) => errors.length)) process.exitCode = 1;
  } finally {
    if (dirname(await realpath(scratch)) === scratchRoot) {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
