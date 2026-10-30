import { describe, expect, it } from "vitest";
import conf from "../src-tauri/tauri.conf.json?raw";
import { buildPolicy } from "../scripts/security-headers.mjs";

// The desktop app's Content-Security-Policy (#289) lives in src-tauri/tauri.conf.json, where Tauri adds the hashes of its own scripts and
// styles to it at build time. It is the web client's policy (client/scripts/security-headers.mjs) with the differences this app needs and
// nothing else, and these tests say which they are, so the two cannot drift apart unnoticed. It was tried in a real build of the app on
// Windows (docs/security.md); it has not been tried on macOS or Linux.

const csp = (JSON.parse(conf) as { app: { security: { csp: Record<string, string> | null } } }).app.security.csp;
const web = Object.fromEntries(buildPolicy("").split("; ").map((d) => [d.slice(0, d.indexOf(" ")), d.slice(d.indexOf(" ") + 1)]));

describe("the desktop app's Content-Security-Policy", () => {
  it("is set: `null` is no policy at all", () => {
    expect(csp).not.toBeNull();
    expect(typeof csp).toBe("object");
  });

  it("lets no script run but the app's own: nothing inline, no eval, no wildcard", () => {
    // Tauri adds a hash or nonce for each of its own inline scripts to this at build time; the page's own scripts are in files here.
    expect(csp!["script-src"]).toBe("'self'");
    for (const [name, value] of Object.entries(csp!)) expect(value, name).not.toMatch(/unsafe-eval|\*/);
    expect(csp!["default-src"]).toBe("'self'");
  });

  it("allows no inline style either (#299): React sets styles through the CSSOM, which needs no `unsafe-inline`", () => {
    expect(csp!["style-src"]).not.toMatch(/unsafe-inline|unsafe-eval|[*]/);
    expect(csp!["style-src"]).toBe("'self'");
  });

  it("lets the page talk to Tauri: without these every command (notifications, updates, restart) fails, and nothing says why", () => {
    expect(csp!["connect-src"]).toContain("ipc:");
    expect(csp!["connect-src"]).toContain("http://ipc.localhost"); // how Windows and Android carry it
  });

  it("is the web client's policy apart from what this app needs: the scripts, the connection to Tauri, and no frame-ancestors", () => {
    const differ = new Set(["script-src", "connect-src", "frame-ancestors"]);
    for (const [name, value] of Object.entries(web)) {
      if (differ.has(name)) continue;
      expect(csp![name], name).toBe(value);
    }
    for (const name of Object.keys(csp!)) expect(web[name], `${name} is not in the web policy`).toBeDefined();
    // The connection list is the web one with Tauri's addition, so a server the web client can reach is one the app can.
    expect(csp!["connect-src"].replace("ipc: http://ipc.localhost ", "")).toBe(web["connect-src"]);
  });
});
