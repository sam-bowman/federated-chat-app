import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandOption, CommunityCommand, CommunityCommands, PublicUser } from "../api";
import type { EmoticonSets } from "../lib/emoticonSets";
import Composer from "./Composer";

type ComposerProps = React.ComponentProps<typeof Composer>;

vi.mock("../context/WsContext", () => ({ useWs: () => ({ sendTyping: vi.fn() }) }));
vi.mock("../lib/emojiData", async (importActual) => ({ ...(await importActual<typeof import("../lib/emojiData")>()), loadEmojiGroups: vi.fn().mockResolvedValue([]) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const robo = { id: "robo", identity: "@robo:chat.example", username: "robo", displayName: "Robo", isBot: true } as PublicUser;
const cmd = (name: string, options: CommandOption[] = [], over: Partial<CommunityCommand> = {}): CommunityCommand => ({ id: name, name, description: `${name} things`, options, bot: robo, botOnline: true, ...over });
const emptySets: EmoticonSets = { personal: [], saved: [], community: [] };

function setup(commands: CommunityCommand[], canUse = true, over: { onRunCommand?: Mock<NonNullable<ComposerProps["onRunCommand"]>> | null } = {}) {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const onRunCommand: Mock<NonNullable<ComposerProps["onRunCommand"]>> | undefined = over.onRunCommand === null ? undefined : (over.onRunCommand ?? vi.fn<NonNullable<ComposerProps["onRunCommand"]>>().mockResolvedValue(undefined));
  const commandSet: CommunityCommands = { commands, canUse };
  render(
    <MemoryRouter>
      <Composer placeholder="Message #general" emoticons={emptySets} typingTarget={{ channelId: "ch1" }} onSend={onSend} commandSet={commandSet} onRunCommand={onRunCommand} />
    </MemoryRouter>
  );
  const input = screen.getByPlaceholderText("Message #general") as HTMLInputElement;
  return { onSend, onRunCommand, input };
}

function type(input: HTMLInputElement, value: string, caret = value.length) {
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(caret, caret);
  fireEvent.select(input);
}
const list = () => screen.queryByRole("listbox", { name: "Command suggestions" });
const optionNames = () => screen.queryAllByRole("option").map((o) => o.querySelector("span")!.textContent);

describe("Composer slash commands", () => {
  it("lists the commands when a message starts with a slash, narrowing as more is typed, each with its bot", () => {
    const { input } = setup([cmd("request"), cmd("ping"), cmd("repeat")]);
    type(input, "/");
    expect(optionNames()).toEqual(["/request", "/ping", "/repeat"]);
    expect(list()!.querySelector(".bot-badge")).not.toBeNull();
    type(input, "/re");
    expect(optionNames()).toEqual(["/request", "/repeat"]);
    type(input, "/zzz");
    expect(list()).toBeNull();
  });

  it("offers nothing for ordinary text, a slash that is not first, or a slash with a space after the word", () => {
    const { input } = setup([cmd("request")]);
    for (const text of ["hello", "see /req", "/request now", "/request "]) {
      type(input, text);
      expect(list(), text).toBeNull();
    }
  });

  it("offers nothing when the person may not run commands, when there are none, or when nothing can run one (a conversation)", () => {
    const first = setup([cmd("request")], false);
    type(first.input, "/");
    expect(list()).toBeNull();
    cleanup();
    const second = setup([]);
    type(second.input, "/");
    expect(list()).toBeNull();
    cleanup();
    const third = setup([cmd("request")], true, { onRunCommand: null });
    type(third.input, "/");
    expect(list()).toBeNull();
  });

  it("opens the form for the chosen command on Enter, clears the box, and does not send the slash as a message", () => {
    const { input, onSend } = setup([cmd("request", [{ name: "title", description: "d", type: "string", required: true }])]);
    type(input, "/req");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("form", { name: "Run /request" })).toBeTruthy();
    expect(input.value).toBe("");
    expect(list()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("moves through the list with the arrow keys (and round), choosing with Tab or a click", () => {
    const { input } = setup([cmd("aaa"), cmd("aab"), cmd("aac")]);
    type(input, "/aa");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByRole("form", { name: "Run /aab" })).toBeTruthy();
    cleanup();
    const second = setup([cmd("aaa"), cmd("aab")]);
    type(second.input, "/");
    fireEvent.click(screen.getByRole("option", { name: /aab/ }));
    expect(screen.getByRole("form", { name: "Run /aab" })).toBeTruthy();
  });

  it("closes the list on Escape until something else is typed, and then Enter sends the text as it is", async () => {
    const { input, onSend } = setup([cmd("request")]);
    type(input, "/req");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(list()).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/req", undefined));
    type(input, "/re");
    expect(list()).not.toBeNull();
  });

  it("sends a slash message that is not a command as the text it is", async () => {
    const { input, onSend } = setup([cmd("request")]);
    type(input, "/shrug whatever");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/shrug whatever", undefined));
  });

  it("marks a command whose bot is offline", () => {
    const { input } = setup([cmd("request", [], { botOnline: false })]);
    type(input, "/");
    expect(screen.getByRole("option").className).toContain("command-suggestion-offline");
    expect(screen.getByRole("option").textContent).toContain("offline");
  });

  it("runs the command with the entered options, then closes the form and puts the cursor back in the box", async () => {
    const { input, onRunCommand } = setup([cmd("echo", [{ name: "text", description: "d", type: "string", required: true }])]);
    type(input, "/echo");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(screen.getByLabelText(/^text/), { target: { value: "hi" } });
    fireEvent.click(within(screen.getByRole("form", { name: /^Run \// })).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onRunCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "echo" }), { text: "hi" }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(document.activeElement).toBe(input);
  });

  it("keeps the form open when the server refuses, and closes it on Cancel", async () => {
    const onRunCommand = vi.fn<NonNullable<ComposerProps["onRunCommand"]>>().mockRejectedValue(new Error("boom"));
    const { input } = setup([cmd("ping")], true, { onRunCommand });
    type(input, "/ping");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(within(screen.getByRole("form", { name: /^Run \// })).getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("form", { name: "Run /ping" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("says the list is open to a screen reader, and which entry is chosen", () => {
    const { input } = setup([cmd("aaa"), cmd("aab")]);
    type(input, "/aa");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const id = input.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(id)!.textContent).toContain("/aaa");
    expect(input.getAttribute("aria-controls")).toBe(list()!.id);
  });
  it("does not list commands again while a form is open, even if a slash is typed", () => {
    const { input } = setup([cmd("request")]);
    type(input, "/req");
    fireEvent.keyDown(input, { key: "Enter" });
    type(input, "/");
    expect(list()).toBeNull();
  });

  it("goes back to the first entry when more is typed after moving down", () => {
    const { input } = setup([cmd("aaa"), cmd("aab"), cmd("aac")]);
    type(input, "/aa");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    type(input, "/a");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("puts the cursor back in the box when the form is cancelled", () => {
    const { input } = setup([cmd("ping")]);
    type(input, "/ping");
    fireEvent.keyDown(input, { key: "Enter" });
    input.blur(); // the person's focus was in the form; the box must get it back
    expect(document.activeElement).not.toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(input);
  });

  it("keeps the cursor in the box while a suggestion is chosen with the mouse", () => {
    const { input } = setup([cmd("ping")]);
    type(input, "/");
    // preventDefault on mousedown is what stops the button taking focus: fireEvent returns false when the default was prevented.
    expect(fireEvent.mouseDown(screen.getByRole("option"))).toBe(false);
  });
  // Found in a real browser, not by the jsdom tests: the form was rendered inside the composer's own <form>, and a <form> inside a <form> is invalid HTML (React
  // warned "cannot be a descendant of <form>") so Send in the command form did not run the command.
  it("keeps the command form outside the message box's own form", () => {
    const { input } = setup([cmd("ping")]);
    type(input, "/ping");
    fireEvent.keyDown(input, { key: "Enter" });
    const form = screen.getByRole("form", { name: "Run /ping" });
    expect(form.parentElement!.closest("form")).toBeNull();
  });
});
