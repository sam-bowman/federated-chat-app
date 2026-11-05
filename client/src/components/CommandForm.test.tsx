import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandOption, CommunityCommand, PublicUser } from "../api";
import { ApiError } from "../api/client";
import CommandForm from "./CommandForm";

afterEach(cleanup);

const robo = { id: "robo", identity: "@robo:chat.example", username: "robo", displayName: "Robo", isBot: true } as PublicUser;
const opt = (over: Partial<CommandOption> & { name: string }): CommandOption => ({ description: `about ${over.name}`, type: "string", required: false, ...over });
const command = (options: CommandOption[], over: Partial<CommunityCommand> = {}): CommunityCommand => ({ id: "c1", name: "request", description: "Ask for a film", options, bot: robo, botOnline: true, ...over });

const members = [{ id: "M1", displayName: "Ann", identity: "@ann:chat.example" }];
const channels = [{ id: "C1", name: "general" }];

function setup(cmd: CommunityCommand, onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const onCancel = vi.fn();
  render(<CommandForm command={cmd} members={members} channels={channels} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}
const send = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("CommandForm", () => {
  it("names the command, its bot (with the Bot mark) and who will see what is entered", () => {
    setup(command([opt({ name: "title", required: true })]));
    const form = screen.getByRole("form", { name: "Run /request" });
    expect(form.textContent).toContain("Ask for a film");
    expect(form.textContent).toContain("Robo");
    expect(form.querySelector(".bot-badge")).not.toBeNull();
    expect(form.textContent).toContain("Robo will see what you enter here.");
  });

  it("puts the cursor in the first field and labels each, marking required ones", () => {
    setup(command([opt({ name: "title", required: true }), opt({ name: "note" })]));
    expect(document.activeElement).toBe(screen.getByLabelText(/^title/));
    expect(screen.getByText("(required)")).toBeTruthy();
    expect(screen.getByText("about note")).toBeTruthy();
  });

  it("will not send until every required field has something in it, then sends the typed values", async () => {
    const { onSubmit } = setup(command([opt({ name: "title", required: true }), opt({ name: "count", type: "integer" }), opt({ name: "loud", type: "boolean" })]));
    expect(send().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^title/), { target: { value: "  Dune " } });
    fireEvent.change(screen.getByLabelText("count"), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText("loud"));
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ title: "Dune", count: 3, loud: true }));
  });

  it("uses number boxes for numbers", () => {
    setup(command([opt({ name: "count", type: "integer" }), opt({ name: "ratio", type: "number" })]));
    expect(screen.getByLabelText("count").getAttribute("type")).toBe("number");
    expect(screen.getByLabelText("ratio").getAttribute("type")).toBe("number");
  });

  it("shows a mistake beside its field and does not send", () => {
    const { onSubmit } = setup(command([opt({ name: "count", type: "integer" })]));
    fireEvent.change(screen.getByLabelText("count"), { target: { value: "1.5" } });
    fireEvent.click(send());
    expect(screen.getByText("Enter a whole number.")).toBeTruthy();
    expect((screen.getByLabelText("count") as HTMLInputElement).getAttribute("aria-invalid")).toBe("true");
    expect(onSubmit).not.toHaveBeenCalled();
    // Typing in it takes the message away.
    fireEvent.change(screen.getByLabelText("count"), { target: { value: "2" } });
    expect(screen.queryByText("Enter a whole number.")).toBeNull();
  });

  it("offers menus for choices, members and channels, and sends the chosen ids", async () => {
    const { onSubmit } = setup(
      command([
        opt({ name: "kind", required: true, choices: [{ name: "Film", value: "film" }, { name: "Show", value: "show" }] }),
        opt({ name: "who", type: "member" }),
        opt({ name: "where", type: "channel" }),
      ])
    );
    fireEvent.change(screen.getByLabelText(/^kind/), { target: { value: "show" } });
    fireEvent.change(screen.getByLabelText("who"), { target: { value: "M1" } });
    fireEvent.change(screen.getByLabelText("where"), { target: { value: "C1" } });
    expect(screen.getByRole("option", { name: "Ann (@ann:chat.example)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "#general" })).toBeTruthy();
    fireEvent.click(send());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ kind: "show", who: "M1", where: "C1" }));
  });

  it("says a bot that is offline cannot be sent anything, and does not send", () => {
    const { onSubmit } = setup(command([], { botOnline: false }));
    expect(screen.getByText(/Robo is offline right now/)).toBeTruthy();
    expect(send().disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Run /request" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("words what the server refused with, keeps the form open, and points at the option it did not accept", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(400, { error: "invalid_options", option: "title" }));
    setup(command([opt({ name: "title", required: true })]), onSubmit);
    fireEvent.change(screen.getByLabelText(/^title/), { target: { value: "x" } });
    fireEvent.click(send());
    expect((await screen.findByRole("alert")).textContent).toBe("That doesn't fit what the command asks for.");
    expect(screen.getByText("Not accepted.")).toBeTruthy();
    expect(send().disabled).toBe(false); // can be corrected and sent again
  });

  it("says the bot is offline when the server says so after the form was filled in", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(409, { error: "bot_offline" }));
    setup(command([]), onSubmit);
    fireEvent.click(send());
    expect((await screen.findByRole("alert")).textContent).toBe("Robo is offline right now.");
  });

  it("cannot be sent twice while it is being sent", async () => {
    let finish: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((r) => (finish = r)));
    setup(command([]), onSubmit);
    fireEvent.click(send());
    fireEvent.submit(screen.getByRole("form", { name: "Run /request" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    finish();
  });

  it("is cancelled by Cancel and by Escape", () => {
    const { onCancel } = setup(command([opt({ name: "title" })]));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByLabelText("title"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
