// Runs the BUILT desktop app (Windows) and checks that its Content-Security-Policy (#289, client/src-tauri/tauri.conf.json) is in force
// and that the app still works under it. Nothing but the real thing shows this: Tauri adds its own hashes to the policy when it builds,
// and the page, its inline scripts and the calls to Tauri all have to be allowed by what comes out.
//
// RUN IT BY HAND on a Windows machine (docs/testing.md); it is not run in CI. A workflow for it on GitHub's `windows-latest` could not attach:
// the runner's user is an administrator, so the app is elevated and WebView2 ignores WEBVIEW2_* variables and per-user registry settings
// for an elevated app. Giving the flag through the machine-wide registry setting (HKLM\Software\Policies\Microsoft\Edge\WebView2\
// AdditionalBrowserArguments) did put it on the browser process's command line, but the port still never opened. Not tried: the
// `--do-not-de-elevate` flag, or a self-hosted runner. The diagnostics below are kept to make the next attempt quicker.
//
// How: WebView2 (what the app draws in on Windows) takes a debugging port from an environment variable, so this starts the app with one,
// attaches to its window with Playwright (no browser is downloaded: it only connects), and looks at the page the way a person's app
// would see it. It checks that
//   - the page draws, from the app's own origin;
//   - the policy is there, has no `unsafe-inline`/`unsafe-eval` for scripts or `unsafe-inline` for styles, and names (by hash) every inline script
//     of the built index.html;
//   - the inline script that sets the UI scale before the first paint ran;
//   - a call to Tauri works (the `ipc:` source), and a connection to a server over plain http works (the `connect-src`);
//   - the page is styled (its stylesheet loaded, and styles React sets through the CSSOM apply, which `style-src 'self'` allows, #299);
//   - and that the policy is ENFORCED: a script the page injects is refused, so is one from a data: address, so is a frame, and so is a `style`
//     attribute that arrives as markup.
// macOS and Linux draw in other engines with no such port, so they are not covered by this; docs/security.md says so.
//
//   node .github/scripts/check-desktop-app.mjs client/src-tauri/target/release/app.exe client/dist/index.html
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import { inlineScripts, scriptHash } from "../../client/scripts/security-headers.mjs";

const [exe, indexHtml] = process.argv.slice(2);
if (!exe || !indexHtml) throw new Error("usage: check-desktop-app.mjs <the built app.exe> <the built client/dist/index.html>");

const DEBUG_PORT = 9333;
const problems = [];
const expect = (ok, what) => ok || problems.push(what);

// A plain http server with nothing special about it, standing in for a home server on a local network.
const peer = createServer((_req, res) => res.end("a server"));
await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
const peerUrl = `http://127.0.0.1:${peer.address().port}/`;

const userDataFolder = mkdtempSync(join(tmpdir(), "desktop-csp-"));
const app = spawn(exe, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: userDataFolder,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
// What the app says, and whether it is still running, is all there is to go on when it cannot be attached to (a runner has no one to look at the screen).
let output = "";
let exitedWith;
app.stdout.on("data", (chunk) => (output += chunk));
app.stderr.on("data", (chunk) => (output += chunk));
app.on("error", (error) => (output += `could not start: ${error.message}\n`));
app.on("exit", (code, signal) => (exitedWith = `code ${code}${signal ? `, signal ${signal}` : ""}`));

// The command line of each WebView2 process, from Windows' own process list (PowerShell, passed encoded so no quoting can go wrong).
function webViewCommandLines() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ForEach-Object { $_.CommandLine }`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8", timeout: 30000 });
  return (out.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

function listing(dir) {
  try {
    return readdirSync(dir).join(", ") || "(empty)";
  } catch (error) {
    return `(cannot read: ${error.message})`;
  }
}

// Said when the window cannot be attached to: the app's own state first, then what Windows says about the port and about WebView2's processes.
function describeWhyNotAttached() {
  const run = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 20000 }).stdout ?? "";
  const lines = [
    exitedWith ? `the app exited (${exitedWith}) before the window could be attached to` : "the app is still running, but nothing answered on the debugging port",
    `what the app printed: ${output.trim().slice(0, 1500) || "(nothing)"}`,
    `listening on ${DEBUG_PORT}: ${run("netstat", ["-ano"]).split("\n").filter((l) => l.includes(`:${DEBUG_PORT}`)).join(" | ") || "(nothing)"}`,
    `WebView2 processes: ${run("tasklist", ["/FI", "IMAGENAME eq msedgewebview2.exe"]).split("\n").filter((l) => l.includes("msedgewebview2")).length}`,
    // Whether the debugging flag reached WebView2 at all: its processes' own command lines, and the file a Chromium writes once it has opened the port.
    // Only this run's browser process (its data folder is named in it; the long and the short form of a temp path differ, so the folder's own name is used), whole.
    `this run's WebView2 browser process: ${webViewCommandLines().filter((l) => l.includes(basename(userDataFolder)) && !l.includes("--type=")).map((l) => l.slice(0, 2000)).join("\n    ") || "(none found)"}`,
    `DevToolsActivePort: ${existsSync(join(userDataFolder, "EBWebView", "DevToolsActivePort")) ? "present" : "absent"}; the data folder holds: ${listing(userDataFolder)}`,
  ];
  return lines.join("\n  ");
}

try {
  let browser;
  for (let i = 0; i < 80 && !browser && !exitedWith; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => undefined);
    if (!browser) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!browser) throw new Error(`could not attach to the app's window:\n  ${describeWhyNotAttached()}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForLoadState("load");

  const messages = [];
  page.on("console", (m) => messages.push(m.text()));
  // The UI scale is stored, then the page is loaded again, so what the inline script does with it is seen from a page loaded from scratch.
  await page.evaluate(() => localStorage.setItem("chat.appearance", JSON.stringify({ scale: 125 })));
  await page.reload();
  const drew = await page.waitForSelector("text=/sign in|log in|register|home server/i", { timeout: 30000 }).then(() => true, () => false);
  expect(drew, "the page did not draw (nothing that says sign in or home server appeared)");

  const origin = await page.evaluate(() => location.origin);
  expect(origin === "http://tauri.localhost", `the page is at ${origin}, not the app's own origin`);

  const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get("content-security-policy"));
  expect(!!csp, "the page came with no Content-Security-Policy");
  const script = (csp ?? "").split("; ").find((d) => d.startsWith("script-src ")) ?? "";
  expect(!/unsafe-inline|unsafe-eval/.test(script), `script-src allows ${script}`);
  for (const hash of inlineScripts(readFileSync(indexHtml, "utf8")).map(scriptHash)) {
    expect(script.includes(hash), `the policy does not name an inline script of the page (${hash})`);
  }

  const style = (csp ?? "").split("; ").find((d) => d.startsWith("style-src ")) ?? "";
  expect(!/unsafe-inline|unsafe-eval/.test(style), `style-src allows ${style}`);

  const scale = await page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"));
  expect(scale === "1.25", `the inline script that sets the UI scale did not run (--ui-scale is "${scale}")`);

  // The root font size is the stylesheet's `calc(16px * var(--ui-scale))`: 20px means the stylesheet loaded AND the CSSOM write above applied.
  const rootSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  expect(rootSize === "20px", `the page is not styled as it should be (the root font size is ${rootSize}, not 20px)`);

  // `plugin:app|version` is allowed by the app's default permissions: any answer that is not an error means the call got through.
  const version = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:app|version").then((v) => ({ v }), (e) => ({ error: String(e) })));
  expect(!version.error && /^\d+\.\d+\.\d+/.test(version.v ?? ""), `a call to Tauri failed: ${JSON.stringify(version)}`);

  const reached = await page.evaluate((url) => fetch(url, { mode: "no-cors" }).then(() => true, () => false), peerUrl);
  expect(reached, "a connection to a server over plain http was refused");

  const injected = await page.evaluate(() => new Promise((resolve) => {
    window.__injected = "not run";
    const inline = document.createElement("script");
    inline.textContent = "window.__injected = 'ran'";
    document.body.appendChild(inline);
    const fromData = document.createElement("script");
    fromData.src = "data:text/javascript,window.__injected = 'ran from data'";
    document.body.appendChild(fromData);
    setTimeout(() => resolve(window.__injected), 500);
  }));
  expect(injected === "not run", `a script the page injected ran (${injected}): the policy is not enforced`);
  // Styles written through the CSSOM are allowed (React does that); one that arrives as markup is not.
  const styles = await page.evaluate(() => {
    const viaCssom = document.createElement("div");
    const viaMarkup = document.createElement("div");
    document.body.append(viaCssom, viaMarkup);
    viaCssom.style.color = "rgb(255, 0, 0)";
    viaMarkup.setAttribute("style", "color: rgb(0, 0, 255)");
    return { cssom: getComputedStyle(viaCssom).color, markup: getComputedStyle(viaMarkup).color };
  });
  expect(styles.cssom === "rgb(255, 0, 0)", `a style set through the CSSOM was refused (${styles.cssom}): React would not work`);
  expect(styles.markup !== "rgb(0, 0, 255)", "a style attribute that arrived as markup applied: style-src is not enforced");
  await page.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    document.body.appendChild(frame);
  }, peerUrl);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const refusals = messages.filter((m) => /violates the following Content Security Policy/.test(m));
  expect(refusals.some((m) => /Executing inline script/.test(m)), "the browser did not refuse an inline script");
  expect(refusals.some((m) => /Framing/.test(m)), "the browser did not refuse a frame");
  expect(refusals.some((m) => /Applying inline style/.test(m)), "the browser did not refuse an inline style");
  // Anything it refused that this check did not ask for is something the app itself tried and the policy stopped.
  const unexpected = refusals.filter((m) => !/Executing inline script|Loading the script 'data:|Framing|Applying inline style/.test(m));
  expect(unexpected.length === 0, `the policy refused something the app itself did: ${unexpected[0]?.slice(0, 300)}`);
  await browser.close();
} finally {
  app.kill();
  peer.close();
}

if (problems.length) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log("The desktop app draws under its Content-Security-Policy, which names the page's inline scripts, lets it reach Tauri and a server, and refuses what it should.");
