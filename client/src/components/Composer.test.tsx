import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Emoticon } from "../api";
import type { EmojiGroup } from "../lib/emojiData";
import type { EmoticonSets } from "../lib/emoticonSets";
import Composer from "./Composer";

vi.mock("../context/WsContext", () => ({ useWs: () => ({ sendTyping: vi.fn() }) }));

const fixture: EmojiGroup[] = [
  { key: "smileys-emotion", label: "Smileys & emotion", entries: [{ char: "😀", label: "grinning face", tags: ["grin"] }] },
];
const mockLoad = vi.hoisted(() => vi.fn());
vi.mock("../lib/emojiData", async (importActual) => ({
  ...(await importActual<typeof import("../lib/emojiData")>()),
  loadEmojiGroups: mockLoad,
}));

function emoticon(id: string, trigger: string, name: string, communityId: string | null = null): Emoticon {
  return { id, name, trigger, imageUrl: `https://cdn.example/${id}.png`, communityId } as Emoticon;
}

const party = emoticon("E1", ":party:", "Party");
const parade = emoticon("E2", ":parade:", "Parade");
const frog = emoticon("E3", ":frog:", "Frog");
const sets: EmoticonSets = { personal: [party, parade, frog], saved: [], community: [] };

beforeEach(() => {
  localStorage.clear();
  mockLoad.mockResolvedValue(fixture);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function setup(emoticons: EmoticonSets = sets) {
  const onSend = vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <Composer placeholder="Message #general" emoticons={emoticons} typingTarget={{ channelId: "ch1" }} onSend={onSend} />
    </MemoryRouter>
  );
  const input = screen.getByPlaceholderText("Message #general") as HTMLInputElement;
  return { onSend, input };
}

/** Types `value` and leaves the caret (and, when given, a selection) where a person would have it. */
function type(input: HTMLInputElement, value: string, caret = value.length, selectionEnd = caret) {
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(caret, selectionEnd);
  fireEvent.select(input);
}

const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Emoji and emoticons" }));
const frogCell = () => screen.findByRole("button", { name: "Frog :frog:" });

describe("Composer ':' suggestions", () => {
  it("offers matching emoticons after a colon and two characters, and not before", () => {
    const { input } = setup();
    type(input, ":p");
    expect(screen.queryByRole("listbox")).toBeNull();

    type(input, ":pa");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([":party:Party", ":parade:Parade"]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
  });

  it("does not offer anything for a time, a link or a finished trigger", () => {
    const { input } = setup();
    for (const text of ["at 10:30", "https://example.com", ":party:"]) {
      type(input, text);
      expect(screen.queryByRole("listbox")).toBeNull();
    }
  });

  it("completes with Enter, puts the caret after it, and does not send", () => {
    const { input, onSend } = setup();
    type(input, "look :pa");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("look :party: ");
    expect(input.selectionStart).toBe("look :party: ".length);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("moves with the arrows (wrapping) and completes with Tab", () => {
    const { input } = setup();
    type(input, ":pa");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe(":parade: ");
  });

  it("completes a word in the middle of a message, not at the end", () => {
    const { input } = setup();
    type(input, "so :fr then", 6);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("so :frog: then");
    expect(input.selectionStart).toBe("so :frog: ".length);
  });

  it("completes with a click on a suggestion", () => {
    const { input } = setup();
    type(input, ":pa");
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(input.value).toBe(":parade: ");
  });

  it("is dismissed by Escape until what is being typed changes, and then Enter sends", async () => {
    const { input, onSend } = setup();
    type(input, ":pa");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    type(input, ":par");
    expect(screen.getByRole("listbox")).not.toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(":par", undefined));
  });

  it("sends on Enter when there is nothing to complete", async () => {
    const { input, onSend } = setup();
    type(input, "hello");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", undefined));
  });

  it("never offers an emoticon that would not render: a community's replaces a personal one with the same trigger", () => {
    const shadowing = emoticon("C1", ":party:", "Community party", "com1");
    const { input } = setup({ personal: [party, parade], saved: [], community: [shadowing] });
    type(input, ":party");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Community party");
  });
});

describe("Composer picker", () => {
  it("inserts an emoticon at the caret, not the end, then closes with the caret after it", async () => {
    const { input } = setup();
    type(input, "hello world", 5);
    openPicker();
    fireEvent.click(await frogCell());

    expect(input.value).toBe("hello :frog: world");
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe("hello :frog: ".length);
    expect(input.selectionEnd).toBe("hello :frog: ".length);
  });

  it("replaces the selected text", async () => {
    const { input } = setup();
    type(input, "say WORD now", 4, 8);
    openPicker();
    fireEvent.click(await frogCell());
    expect(input.value).toBe("say :frog: now");
  });

  it("inserts a Unicode emoji exactly as it is", async () => {
    const { input } = setup();
    type(input, "hi", 2);
    openPicker();
    fireEvent.click(await screen.findByRole("button", { name: "grinning face" }));
    expect(input.value).toBe("hi😀");
  });

  it("stays open when Shift is held, and the next pick goes right after the first", async () => {
    const { input } = setup();
    type(input, "x", 1);
    openPicker();
    fireEvent.click(await frogCell(), { shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).not.toBeNull();
    expect(input.value).toBe("x :frog: ");

    fireEvent.click(screen.getByRole("button", { name: "Party :party:" }));
    expect(input.value).toBe("x :frog: :party: ");
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });

  it("stays open while pinned", async () => {
    const { input } = setup();
    openPicker();
    await frogCell();
    fireEvent.click(screen.getByRole("button", { name: /Keep open/ }));
    fireEvent.click(screen.getByRole("button", { name: "Frog :frog:" }));
    fireEvent.click(screen.getByRole("button", { name: "grinning face" }));
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).not.toBeNull();
    expect(input.value).toBe(":frog: 😀");
  });

  it("closes on Escape and gives focus back to the message box", async () => {
    const { input } = setup();
    openPicker();
    await frogCell();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("searches the emoticons as well as the emoji", async () => {
    setup();
    openPicker();
    await frogCell();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "par" } });
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toContain("Party :party:");
    expect(screen.queryByRole("button", { name: "Frog :frog:" })).toBeNull();
  });

  it("explains, with a link, when there are no emoticons yet", async () => {
    setup({ personal: [], saved: [], community: [] });
    openPicker();
    await screen.findByRole("button", { name: "grinning face" });
    expect(screen.getByRole("link", { name: "Make one on the Emoticons page" }).getAttribute("href")).toBe("/emoticons");
  });

  it("closes when its button is pressed again", async () => {
    setup();
    openPicker();
    await frogCell();
    await act(async () => openPicker());
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });
});
