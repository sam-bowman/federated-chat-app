import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../api";
import serverActions from "../../../server/src/lib/auditActions.ts?raw";
import { AUDIT_ACTION_OPTIONS, SOURCE_LABELS, describeAudit } from "./auditText";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  at: "2026-01-01T00:00:00.000Z",
  source: "api",
  action: "member.kick",
  actor: { id: "u1", label: "@alice:chat.example" },
  community: { id: "c1", name: "Club" },
  target: { type: "user", id: "u2", label: "@bob:chat.example" },
  details: {},
  ...over,
});

// The client cannot import the server, so its list of actions is checked against the server's source text: an action added there
// has to be given words here, or the admin page would show only its raw name.
describe("the actions the log knows", () => {
  const serverList = [...serverActions.matchAll(/^\s*"([a-z_]+(?:\.[a-z_0-9]+)+)",?$/gm)].map((m) => m[1]);

  it("found the server's list at all", () => {
    expect(serverList.length).toBeGreaterThanOrEqual(25);
  });

  it("matches the server's, both ways, with no repeats", () => {
    const mine = AUDIT_ACTION_OPTIONS.map((o) => o.value);
    expect(new Set(mine).size).toBe(mine.length);
    expect([...serverList].sort()).toEqual([...mine].sort());
  });

  it("puts each in the scope the server does: moderation in a community, the rest for the server", () => {
    const communityBlock = serverActions.slice(serverActions.indexOf("COMMUNITY_ACTIONS"), serverActions.indexOf("SERVER_ACTIONS"));
    for (const option of AUDIT_ACTION_OPTIONS) {
      expect(communityBlock.includes(`"${option.value}"`), option.value).toBe(option.scope === "community");
    }
  });

  it("has words for every source the server has", () => {
    for (const source of ["api", "admin", "cli", "system"]) expect(SOURCE_LABELS[source], source).toBeTruthy();
  });

  it("gives every action a sentence of its own, never the fallback", () => {
    for (const { value } of AUDIT_ACTION_OPTIONS) {
      expect(describeAudit(entry({ action: value, details: { role: "Mods", channel: "general" } })), value).not.toContain(`did ${value}`);
    }
  });
});

describe("describeAudit", () => {
  it("says who did what to whom, where", () => {
    expect(describeAudit(entry())).toBe("@alice:chat.example removed @bob:chat.example from Club");
    expect(describeAudit(entry({ action: "member.ban" }))).toBe("@alice:chat.example banned @bob:chat.example from Club");
    expect(describeAudit(entry({ action: "member.role.add", details: { role: "Mods" } }))).toBe("@alice:chat.example gave @bob:chat.example the role Mods");
    expect(describeAudit(entry({ action: "member.role.remove", details: { role: "Mods" } }))).toBe("@alice:chat.example took the role Mods from @bob:chat.example");
  });

  it("names what changed, but never anything more", () => {
    expect(describeAudit(entry({ action: "community.update", target: null, details: { fields: ["name", "visibility"], newName: "Secret New" } }))).toBe(
      "@alice:chat.example changed the settings of Club (name, visibility)"
    );
  });

  it("says where a moderator removed a message, and copes without it", () => {
    expect(describeAudit(entry({ action: "message.delete", target: { type: "message", id: "m1", label: null }, details: { channel: "general" } }))).toBe(
      "@alice:chat.example removed someone's message in general"
    );
    expect(describeAudit(entry({ action: "message.delete", target: null }))).toBe("@alice:chat.example removed someone's message");
  });

  it("reads for the operator and the system, and for a person who is gone", () => {
    expect(describeAudit(entry({ action: "user.suspend", actor: { id: null, label: "the operator (command line)" }, community: null }))).toBe(
      "the operator (command line) suspended @bob:chat.example"
    );
    expect(describeAudit(entry({ action: "account.erase", actor: { id: null, label: "the server (automatic)" }, target: { type: "user", id: "u2", label: "Deleted user" } }))).toBe(
      "the server (automatic) erased the account Deleted user"
    );
  });

  it("falls back to ids and to the action's own name rather than failing", () => {
    expect(describeAudit(entry({ target: { type: "user", id: "u2", label: null } }))).toContain("u2");
    expect(describeAudit(entry({ target: null }))).toContain("something");
    expect(describeAudit(entry({ action: "something.new" }))).toBe("@alice:chat.example did something.new");
  });

  it("keeps markup a person typed as the text it is: only ever a string", () => {
    const line = describeAudit(entry({ actor: { id: "u1", label: "<img src=x onerror=alert(1)>" } }));
    expect(typeof line).toBe("string");
    expect(line).toContain("<img src=x onerror=alert(1)>");
  });
});
