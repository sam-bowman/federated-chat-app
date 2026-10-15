import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountFooter from "./AccountFooter";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(presence: { status: string; customStatus: string | null } = { status: "ONLINE", customStatus: null }) {
  const onSetPresence = vi.fn().mockResolvedValue(undefined);
  const user = { displayName: "Sam", avatarUrl: null, identity: "@sam:chat.example", presence };
  const view = render(<AccountFooter user={user} onOpenSettings={vi.fn()} onSignOut={vi.fn()} onSetPresence={onSetPresence} />);
  return { onSetPresence, user, ...view };
}

const statusButton = (name: RegExp | string) => screen.getByRole("button", { name });
const menu = () => screen.getByRole("menu", { name: "Status" });
const item = (name: string) => within(menu()).getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

describe("the status in the footer", () => {
  it.each([
    ["ONLINE", "Online"],
    ["AWAY", "Away"],
    ["BUSY", "Busy"],
    ["DO_NOT_DISTURB", "Do not disturb"],
    ["INVISIBLE", "Invisible (others see you offline)"],
  ])("always shows %s, in words and as a dot", (status, words) => {
    setup({ status, customStatus: null });

    expect(document.querySelector(".account-status-text")!.textContent).toBe(words);
    expect(document.querySelector(`.account-status .presence-dot.${status}`)).not.toBeNull();
    expect(document.querySelector(`.account-avatar .presence-dot.${status}`)).not.toBeNull();
  });

  it("announces the status to a screen reader on the control that changes it", () => {
    setup({ status: "DO_NOT_DISTURB", customStatus: null });

    expect(statusButton("Status: Do not disturb. Change status")).toBeTruthy();
  });

  it("shows the custom status under the name, and in the announcement", () => {
    setup({ status: "BUSY", customStatus: "in a meeting" });

    expect(document.querySelector(".account-custom-status")!.textContent).toBe("in a meeting");
    expect(statusButton("Status: Busy, in a meeting. Change status")).toBeTruthy();
  });

  it("shows no custom status line when there is none", () => {
    setup();

    expect(document.querySelector(".account-custom-status")).toBeNull();
  });

  // The dots beside the words are decoration; reading "Online" twice, or a raw "DO_NOT_DISTURB", would be noise.
  it("does not make the dots next to the words speak as well", () => {
    setup({ status: "BUSY", customStatus: null });

    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });
});

describe("the status menu", () => {
  it("is closed until the status is pressed, and opens above the footer with all five statuses", () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(statusButton(/Change status/));

    expect(screen.getByRole("dialog", { name: "Set your status" })).toBeTruthy();
    expect(within(menu()).getAllByRole("menuitemradio").map((o) => o.textContent)).toEqual([
      "OnlineYou're available✓",
      "AwayYou've stepped away",
      "BusyOthers see that you're busy",
      "Do not disturbOthers see that you'd rather not be disturbed",
      "InvisibleYou appear offline to everyone else",
    ]);
    expect(statusButton(/Change status/).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens from the avatar too, which is the same menu", () => {
    setup();

    fireEvent.click(document.querySelector(".account-avatar")!);

    expect(screen.getByRole("dialog", { name: "Set your status" })).toBeTruthy();
  });

  it("closes again when the same control is pressed", () => {
    setup();

    fireEvent.click(statusButton(/Change status/));
    fireEvent.mouseDown(statusButton(/Change status/)); // a press on the opener is its own toggle, not "outside"
    fireEvent.click(statusButton(/Change status/));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the current status as checked and starts focus on it", () => {
    setup({ status: "AWAY", customStatus: null });

    fireEvent.click(statusButton(/Change status/));

    expect(item("Away").getAttribute("aria-checked")).toBe("true");
    expect(item("Online").getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(item("Away"));
  });

  it("applies a choice at once, closes, and tells a screen reader", async () => {
    const { onSetPresence } = setup();
    fireEvent.click(statusButton(/Change status/));

    fireEvent.click(item("Busy"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSetPresence).toHaveBeenCalledWith({ status: "BUSY" });
    expect(screen.getByRole("status").textContent).toBe("Status set to Busy");
  });

  it("puts focus back on the status control after a choice", async () => {
    setup();
    statusButton(/Change status/).focus();
    fireEvent.click(statusButton(/Change status/));

    fireEvent.click(item("Away"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(statusButton(/Change status/));
  });

  it("does not call the server for the status you already have", () => {
    const { onSetPresence } = setup({ status: "BUSY", customStatus: null });
    fireEvent.click(statusButton(/Change status/));

    fireEvent.click(item("Busy"));

    expect(onSetPresence).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open and says so when the change fails", async () => {
    const { onSetPresence } = setup();
    onSetPresence.mockRejectedValue(new Error("offline"));
    fireEvent.click(statusButton(/Change status/));

    fireEvent.click(item("Busy"));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't change your status.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((item("Away") as HTMLButtonElement).disabled).toBe(false); // can try again
  });
});

describe("the status menu and the keyboard", () => {
  it("moves between statuses with the arrow keys, wrapping, and Home and End", () => {
    setup({ status: "ONLINE", customStatus: null });
    fireEvent.click(statusButton(/Change status/));

    fireEvent.keyDown(item("Online"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Away"));

    fireEvent.keyDown(item("Away"), { key: "ArrowUp" });
    fireEvent.keyDown(item("Online"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(item("Invisible")); // wrapped round

    fireEvent.keyDown(item("Invisible"), { key: "Home" });
    expect(document.activeElement).toBe(item("Online"));
    fireEvent.keyDown(item("Online"), { key: "End" });
    expect(document.activeElement).toBe(item("Invisible"));
  });

  it("has only the current status in the tab order, so the menu is one stop", () => {
    setup({ status: "BUSY", customStatus: null });
    fireEvent.click(statusButton(/Change status/));

    expect(within(menu()).getAllByRole("menuitemradio").map((o) => (o as HTMLButtonElement).tabIndex)).toEqual([-1, -1, 0, -1, -1]);
  });

  it("closes on Escape and gives focus back to the control that opened it", () => {
    setup();
    statusButton(/Change status/).focus();
    fireEvent.click(statusButton(/Change status/));

    fireEvent.keyDown(item("Online"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(statusButton(/Change status/));
  });

  it("gives focus back to the avatar when that is what opened it", () => {
    setup();
    const avatar = document.querySelector(".account-avatar") as HTMLElement;
    fireEvent.click(avatar);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(document.activeElement).toBe(avatar);
  });

  it("closes on a press outside, without stealing focus", () => {
    setup();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.click(statusButton(/Change status/));

    fireEvent.mouseDown(outside);

    expect(screen.queryByRole("dialog")).toBeNull();
    outside.remove();
  });

  it("stays open for a press inside it", () => {
    setup();
    fireEvent.click(statusButton(/Change status/));

    fireEvent.mouseDown(screen.getByRole("dialog"));

    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the custom status in the menu", () => {
  const field = () => screen.getByRole("textbox", { name: "Custom status" }) as HTMLInputElement;

  it("sets it, closes, and tells a screen reader", async () => {
    const { onSetPresence } = setup();
    fireEvent.click(statusButton(/Change status/));

    fireEvent.change(field(), { target: { value: "  lunch  " } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSetPresence).toHaveBeenCalledWith({ customStatus: "lunch" });
    expect(screen.getByRole("status").textContent).toBe("Custom status set");
  });

  it("can be set with Enter", async () => {
    const { onSetPresence } = setup();
    fireEvent.click(statusButton(/Change status/));

    fireEvent.change(field(), { target: { value: "lunch" } });
    fireEvent.submit(field().closest("form")!);

    await waitFor(() => expect(onSetPresence).toHaveBeenCalledWith({ customStatus: "lunch" }));
  });

  it("starts from the saved one, and clears it", async () => {
    const { onSetPresence } = setup({ status: "ONLINE", customStatus: "in a meeting" });
    fireEvent.click(statusButton(/Change status/));
    expect(field().value).toBe("in a meeting");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(onSetPresence).toHaveBeenCalledWith({ customStatus: null }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Custom status cleared"));
  });

  it("will not set an empty status or an unchanged one", () => {
    setup({ status: "ONLINE", customStatus: "in a meeting" });
    fireEvent.click(statusButton(/Change status/));
    const set = screen.getByRole("button", { name: "Set" }) as HTMLButtonElement;

    expect(set.disabled).toBe(true); // unchanged
    fireEvent.change(field(), { target: { value: "   " } });
    expect(set.disabled).toBe(true); // nothing
    fireEvent.change(field(), { target: { value: "in a call" } });
    expect(set.disabled).toBe(false);
  });

  it("keeps the menu open and says so when saving fails", async () => {
    const { onSetPresence } = setup();
    onSetPresence.mockRejectedValue(new Error("offline"));
    fireEvent.click(statusButton(/Change status/));

    fireEvent.change(field(), { target: { value: "lunch" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save your status.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps the field away from password managers, and within the server's limit", () => {
    setup();
    fireEvent.click(statusButton(/Change status/));

    expect(field().hasAttribute("data-1p-ignore")).toBe(true);
    expect(field().maxLength).toBe(128);
  });
});
