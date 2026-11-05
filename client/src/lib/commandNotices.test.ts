import { describe, expect, it } from "vitest";
import { noticeText, noticesReducer, type Notice, type NoticeBase } from "./commandNotices";

const base = (id: string, channelId = "ch1"): NoticeBase => ({ interactionId: id, channelId, botName: "Robo", commandName: "request" });
const sent = (state: Notice[], id: string, channelId = "ch1") => noticesReducer(state, { type: "sent", notice: base(id, channelId) });
const kinds = (state: Notice[]) => state.map((n) => `${n.interactionId}:${n.kind}`);

describe("the notices after running a command", () => {
  it("starts waiting, once for each command run", () => {
    let state = sent([], "i1");
    state = sent(state, "i1");
    state = sent(state, "i2");
    expect(kinds(state)).toEqual(["i1:waiting", "i2:waiting"]);
  });

  it("goes from waiting to thinking when the bot says so, and only then", () => {
    let state = sent(sent([], "i1"), "i2");
    state = noticesReducer(state, { type: "deferred", interactionId: "i1" });
    expect(kinds(state)).toEqual(["i1:thinking", "i2:waiting"]);
    // A failure or a private reply that got there first is not turned back into thinking.
    state = noticesReducer(state, { type: "giveUp", interactionId: "i2" });
    state = noticesReducer(state, { type: "deferred", interactionId: "i2" });
    expect(kinds(state)).toEqual(["i1:thinking", "i2:failed"]);
    state = noticesReducer(state, { type: "response", notice: base("i1"), content: "x", richEmbeds: [] });
    state = noticesReducer(state, { type: "deferred", interactionId: "i1" });
    expect(kinds(state)).toEqual(["i1:private", "i2:failed"]);
  });

  it("is replaced by a private reply, which keeps its words and cards, and a reply for one this page does not know is shown too (another tab ran it)", () => {
    let state = sent([], "i1");
    state = noticesReducer(state, { type: "response", notice: base("i1"), content: "Only you", richEmbeds: [{ title: "Card" }] });
    expect(state).toEqual([{ ...base("i1"), kind: "private", content: "Only you", richEmbeds: [{ title: "Card" }] }]);
    state = noticesReducer(state, { type: "response", notice: base("i9"), content: "From another tab", richEmbeds: [] });
    expect(kinds(state)).toEqual(["i1:private", "i9:private"]);
  });

  it("goes when a public answer arrives, and only that one", () => {
    const state = noticesReducer(sent(sent([], "i1"), "i2"), { type: "answered", interactionId: "i1" });
    expect(kinds(state)).toEqual(["i2:waiting"]);
  });

  it("says it did not respond only for one that was still waiting or thinking", () => {
    let state = sent(sent([], "i1"), "i2");
    state = noticesReducer(state, { type: "deferred", interactionId: "i2" });
    state = noticesReducer(state, { type: "giveUp", interactionId: "i1" });
    state = noticesReducer(state, { type: "giveUp", interactionId: "i2" });
    expect(kinds(state)).toEqual(["i1:failed", "i2:failed"]);
    state = noticesReducer(state, { type: "response", notice: base("i1"), content: "late", richEmbeds: [] });
    state = noticesReducer(state, { type: "giveUp", interactionId: "i1" });
    expect(kinds(state)).toEqual(["i1:private", "i2:failed"]);
  });

  it("can be dismissed", () => {
    expect(kinds(noticesReducer(sent(sent([], "i1"), "i2"), { type: "dismiss", interactionId: "i1" }))).toEqual(["i2:waiting"]);
  });

  it("keeps only the channel that is open when another is left for", () => {
    let state = sent(sent(sent([], "i1", "ch1"), "i2", "ch2"), "i3", "ch1");
    state = noticesReducer(state, { type: "leave", channelId: "ch2" });
    expect(kinds(state)).toEqual(["i2:waiting"]);
  });

  it("does not change the state it was given", () => {
    const before = sent([], "i1");
    const copy = JSON.stringify(before);
    noticesReducer(before, { type: "deferred", interactionId: "i1" });
    noticesReducer(before, { type: "answered", interactionId: "i1" });
    expect(JSON.stringify(before)).toBe(copy);
  });
});

describe("noticeText", () => {
  it("says what each is, naming the bot and the command", () => {
    const notice = (kind: Notice["kind"]) => (kind === "private" ? ({ ...base("i"), kind, content: "", richEmbeds: [] } as Notice) : ({ ...base("i"), kind } as Notice));
    expect(noticeText(notice("waiting"))).toBe("Waiting for Robo…");
    expect(noticeText(notice("thinking"))).toBe("Robo is thinking…");
    expect(noticeText(notice("failed"))).toBe("Robo didn't respond to /request.");
    expect(noticeText(notice("private"))).toBe("Only you can see this · Robo · /request");
  });
});
