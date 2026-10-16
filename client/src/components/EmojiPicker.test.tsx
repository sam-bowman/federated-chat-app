import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Emoticon } from "../api";
import type { EmojiGroup } from "../lib/emojiData";
import type { EmoticonSets } from "../lib/emoticonSets";
import { getRecentEmoji } from "../lib/recentEmoji";
import EmojiPicker, { EMOJI_PICKER_TRIGGER_ATTR, EmojiPopover } from "./EmojiPicker";

const fixture: EmojiGroup[] = [
  {
    key: "smileys-emotion",
    label: "Smileys & emotion",
    entries: [
      { char: "😀", label: "grinning face", tags: ["grin"] },
      { char: "😂", label: "face with tears of joy", tags: ["laugh"] },
      { char: "😍", label: "smiling face with heart-eyes", tags: ["love"] },
    ],
  },
  {
    key: "animals-nature",
    label: "Animals & nature",
    entries: [{ char: "🐱", label: "cat face", tags: ["cat", "pet"] }],
  },
];

const mockLoad = vi.hoisted(() => vi.fn());
vi.mock("../lib/emojiData", async (importActual) => ({
  ...(await importActual<typeof import("../lib/emojiData")>()),
  loadEmojiGroups: mockLoad,
}));

beforeEach(() => {
  localStorage.clear();
  mockLoad.mockResolvedValue(fixture);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function open() {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const view = render(<EmojiPicker onPick={onPick} onClose={onClose} />);
  return { onPick, onClose, ...view };
}

const ready = () => screen.findByRole("button", { name: "grinning face" });

describe("EmojiPicker", () => {
  it("shows a loading note, then every category with its emoji", async () => {
    open();
    expect(screen.getByText("Loading emoji…")).not.toBeNull();

    await ready();
    expect(screen.getByRole("region", { name: "Smileys & emotion" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Animals & nature" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "cat face" }).textContent).toBe("🐱");
  });

  it("picks an emoji on click, remembers it, and does not close by itself", async () => {
    const { onPick, onClose } = open();
    fireEvent.click(await ready());

    expect(onPick).toHaveBeenCalledWith("😀", { keepOpen: false });
    expect(onClose).not.toHaveBeenCalled();
    expect(getRecentEmoji()).toEqual(["😀"]);
  });

  it("lists recently used emoji first, labelled", async () => {
    localStorage.setItem("chat.recentEmoji", JSON.stringify(["🐱"]));
    open();
    await ready();

    const recent = screen.getByRole("region", { name: "Recently used" });
    expect(recent.querySelector("button")!.textContent).toBe("🐱");
    expect(recent.querySelector("button")!.getAttribute("aria-label")).toBe("cat face");
  });

  it("searches names and tags, and says when nothing matches", async () => {
    open();
    await ready();
    const search = screen.getByRole("searchbox", { name: "Search emoji" });

    fireEvent.change(search, { target: { value: "laugh" } });
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["face with tears of joy"]);
    expect(screen.queryByRole("region", { name: "Smileys & emotion" })).toBeNull();

    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText('No emoji match "zzzz".')).not.toBeNull();
  });

  it("closes on Escape and on a click outside, but not on a click inside or on its trigger", async () => {
    const { onClose } = open();
    await ready();

    fireEvent.mouseDown(screen.getByRole("searchbox"));
    expect(onClose).not.toHaveBeenCalled();

    const trigger = document.createElement("button");
    trigger.setAttribute(EMOJI_PICKER_TRIGGER_ATTR, "");
    document.body.appendChild(trigger);
    fireEvent.mouseDown(trigger);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    trigger.remove();
  });

  it("moves through the emoji with the keyboard", async () => {
    open();
    await ready();
    const cell = (name: string) => screen.getByRole("button", { name });
    const search = screen.getByRole("searchbox");

    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell("grinning face"));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell("face with tears of joy"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(cell("cat face"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell("smiling face with heart-eyes"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(cell("grinning face"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(search);
  });

  it("offers a retry when the emoji can't be loaded", async () => {
    mockLoad.mockRejectedValueOnce(new Error("offline"));
    open();

    const retry = await screen.findByText("Try again");
    expect(screen.getByText(/Couldn't load the emoji list/)).not.toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: "grinning face" })).not.toBeNull());
  });
});

describe("EmojiPopover: size and position follow the UI scale", () => {
  const anchor = (over: Partial<DOMRect> = {}) => ({ left: 700, right: 740, top: 400, bottom: 430, width: 40, height: 30, x: 700, y: 400, toJSON: () => ({}), ...over }) as DOMRect;
  const popover = () => document.querySelector(".emoji-popover") as HTMLElement;
  const setViewport = (width: number, height: number) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  };
  afterEach(() => {
    document.documentElement.style.fontSize = "";
    setViewport(1024, 768);
    cleanup();
  });

  it("is 21.25rem by 23.75rem: 340 by 380 pixels at 100%", () => {
    mockLoad.mockResolvedValue(fixture);
    setViewport(1600, 1200);
    document.documentElement.style.fontSize = "16px";
    render(<EmojiPopover anchor={anchor()} onPick={() => {}} onClose={() => {}} />);

    expect(popover().style.width).toBe("340px");
    expect(popover().style.height).toBe("380px");
  });

  it("doubles with the UI scale (a 32px root)", () => {
    mockLoad.mockResolvedValue(fixture);
    setViewport(2000, 1500);
    document.documentElement.style.fontSize = "32px";
    render(<EmojiPopover anchor={anchor()} onPick={() => {}} onClose={() => {}} />);

    expect(popover().style.width).toBe("680px");
    expect(popover().style.height).toBe("760px");
  });

  it("shrinks to fit a window that is smaller than it, rather than running off the page", () => {
    mockLoad.mockResolvedValue(fixture);
    setViewport(400, 500);
    document.documentElement.style.fontSize = "32px";
    render(<EmojiPopover anchor={anchor({ left: 350, right: 390 })} onPick={() => {}} onClose={() => {}} />);

    const width = parseFloat(popover().style.width);
    const left = parseFloat(popover().style.left);
    expect(width).toBeLessThanOrEqual(400 - 2 * 16);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(400);
    expect(parseFloat(popover().style.height)).toBeLessThanOrEqual(500 - 2 * 16);
  });
});

describe("EmojiPicker with custom emoticons", () => {
  const emoticon = (id: string, trigger: string, name: string, communityId: string | null = null) =>
    ({ id, trigger, name, communityId, imageUrl: `https://cdn.example/${id}.png` }) as Emoticon;
  const mine = emoticon("E1", ":party:", "Party");
  const kept = emoticon("E2", ":frog:", "Frog");
  const here = emoticon("E3", ":wave:", "Wave", "C1");
  const elsewhere = emoticon("E4", ":boat:", "Boat", "C2");
  const sets: EmoticonSets = { personal: [mine], saved: [kept], community: [elsewhere, here] };

  function openWith(extra: Partial<React.ComponentProps<typeof EmojiPicker>> = {}) {
    const onPick = vi.fn();
    const onPickEmoticon = vi.fn();
    const onClose = vi.fn();
    render(
      <EmojiPicker onPick={onPick} onPickEmoticon={onPickEmoticon} onClose={onClose} emoticons={sets} communityId="C1" {...extra} />
    );
    return { onPick, onPickEmoticon, onClose };
  }

  it("lists the emoticons in sections, the current community's first, then the emoji", async () => {
    openWith();
    await ready();
    const headings = Array.from(document.querySelectorAll(".emoji-heading")).map((h) => h.textContent);
    expect(headings).toEqual(["Your emoticons", "Saved", "This community's", "Other communities'", "Smileys & emotion", "Animals & nature"]);
    expect(within(screen.getByRole("region", { name: "This community's" })).getByRole("button").getAttribute("aria-label")).toBe("Wave :wave:");
  });

  it("calls onPickEmoticon, remembers the pick as recent, and shows it first next time", async () => {
    const { onPickEmoticon, onPick } = openWith();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Frog :frog:" }));

    expect(onPickEmoticon).toHaveBeenCalledWith(kept, { keepOpen: false });
    expect(onPick).not.toHaveBeenCalled();
    expect(getRecentEmoji()).toEqual(["emoticon:E2"]);
    const recent = screen.getByRole("region", { name: "Recently used" });
    expect(recent.querySelector("button")!.getAttribute("aria-label")).toBe("Frog :frog:");
  });

  it("drops a recent emoticon the person can no longer use, and keeps the recent emoji", async () => {
    localStorage.setItem("chat.recentEmoji", JSON.stringify(["emoticon:GONE", "🐱", "emoticon:E1"]));
    openWith();
    await ready();
    const labels = Array.from(screen.getByRole("region", { name: "Recently used" }).querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label")
    );
    expect(labels).toEqual(["cat face", "Party :party:"]);
  });

  it("tells keepOpen when Shift is held or the picker is pinned", async () => {
    const { onPickEmoticon, onPick } = openWith({ pinnable: true });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Frog :frog:" }), { shiftKey: true });
    expect(onPickEmoticon).toHaveBeenLastCalledWith(kept, { keepOpen: true });

    fireEvent.click(screen.getByRole("button", { name: "Keep open" }));
    expect(screen.getByRole("button", { name: "Keep open" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "grinning face" }));
    expect(onPick).toHaveBeenLastCalledWith("😀", { keepOpen: true });
  });

  it("has no pin unless asked to", async () => {
    openWith();
    await ready();
    expect(screen.queryByRole("button", { name: "Keep open" })).toBeNull();
  });

  it("searches names and triggers, emoticons first", async () => {
    openWith();
    await ready();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search emoji and emoticons" }), { target: { value: "wave" } });
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Wave :wave:"]);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(screen.getByText('No emoji or emoticons match "zzzz".')).not.toBeNull();
  });

  it("shows the emoticons straight away, before the emoji have loaded", async () => {
    mockLoad.mockReturnValue(new Promise(() => {}));
    openWith();
    expect(screen.getByRole("button", { name: "Party :party:" })).not.toBeNull();
    expect(screen.getByText("Loading emoji…")).not.toBeNull();
  });

  it("is an emoji-only picker without the emoticons prop", async () => {
    render(<EmojiPicker onPick={() => {}} onClose={() => {}} />);
    await ready();
    expect(screen.getByRole("searchbox", { name: "Search emoji" })).not.toBeNull();
    expect(screen.queryByText(/custom emoticons/)).toBeNull();
  });
});
