import { describe, expect, it } from "vitest";
import type { Conversation } from "../api";
import { emptyPrefs, withSetting } from "./notificationPrefs";
import { canCallConversation, conversationName, decideRing, incomingCalls, mergeCalls } from "./voiceCalls";

const member = (id: string, name: string, domain = "chat.example") => ({ id, displayName: name, identity: `@${id}:${domain}`, nickname: null }) as Conversation["members"][number];
const dm = (id: string, other = member("bea", "Bea")): Conversation => ({ id, type: "DM", title: null, createdAt: "", members: [member("me", "Me"), other] });
const group: Conversation = { id: "G", type: "GROUP", title: "Crew", createdAt: "", members: [member("me", "Me"), member("bea", "Bea"), member("cy", "Cy")] };

describe("which conversations can be called", () => {
  it("those with everyone on this person's own server", () => {
    expect(canCallConversation(dm("D"), "@me:chat.example")).toBe(true);
    expect(canCallConversation(group, "@ME:CHAT.example")).toBe(true);
  });
  it("not one with anybody on another server", () => {
    expect(canCallConversation(dm("D", member("far", "Far", "far.example")), "@me:chat.example")).toBe(false);
  });
});

describe("conversationName", () => {
  it("is the other person for a direct chat and the title for a group", () => {
    expect(conversationName(dm("D"), "me")).toBe("Bea");
    expect(conversationName(group, "me")).toBe("Crew");
    expect(conversationName({ ...group, title: null }, "me")).toBe("Group chat");
    expect(conversationName(undefined, "me")).toBe("call");
  });
});

describe("mergeCalls", () => {
  const ids = ["D", "G"];
  it("changes nothing for an answer that cannot be trusted", () => {
    const prev = { D: ["bea"] };
    expect(mergeCalls(prev, { available: false, calls: {} }, ids)).toBe(prev);
  });
  it("takes the answer as the whole truth for the conversations asked about", () => {
    const next = mergeCalls({ D: ["bea"], X: ["x"] }, { available: true, calls: { G: ["cy"] } }, ids);
    expect(next).toEqual({ D: [], G: ["cy"], X: ["x"] }); // D ended; X was not asked about
  });
  it("gives back the same object when nothing changed", () => {
    const prev = { D: ["bea"] };
    expect(mergeCalls(prev, { available: true, calls: { D: ["bea"] } }, ids)).toBe(prev);
  });
});

describe("incomingCalls", () => {
  const none = new Set<string>();
  it("lists a call with someone in it that this person is not in", () => {
    expect(incomingCalls([dm("D"), group], { D: ["bea"], G: ["bea", "cy"] }, "me", "@me:chat.example", null, none).map((c) => [c.conversation.id, c.callers])).toEqual([
      ["D", ["Bea"]],
      ["G", ["Bea", "Cy"]],
    ]);
  });
  it("leaves out one that is empty, that this person is in, is on screen as their own call, was put away, or cannot be called", () => {
    const far = dm("F", member("far", "Far", "far.example"));
    const people = { D: [], G: ["bea", "me"], F: ["far"], E: ["bea"] };
    expect(incomingCalls([dm("D"), group, far, dm("E")], people, "me", "@me:chat.example", null, new Set(["E"]))).toEqual([]);
    expect(incomingCalls([dm("E")], { E: ["bea"] }, "me", "@me:chat.example", "E", none)).toEqual([]);
  });
  it("ignores people who are not members", () => {
    expect(incomingCalls([dm("D")], { D: ["stranger"] }, "me", "@me:chat.example", null, none)).toEqual([]);
  });
});

describe("decideRing", () => {
  const prefs = emptyPrefs();
  it("rings and notifies by default", () => {
    expect(decideRing("ONLINE", prefs, "D")).toEqual({ sound: true, notify: true });
  });
  it("is silent on Do not disturb", () => {
    expect(decideRing("DO_NOT_DISTURB", prefs, "D")).toEqual({ sound: false, notify: false });
  });
  it("follows what was chosen for that conversation", () => {
    const muted = withSetting(prefs, { type: "CONVERSATION", id: "D", sound: false, notify: null });
    expect(decideRing("ONLINE", muted, "D")).toEqual({ sound: false, notify: true });
    expect(decideRing("ONLINE", muted, "OTHER")).toEqual({ sound: true, notify: true });
  });
});
