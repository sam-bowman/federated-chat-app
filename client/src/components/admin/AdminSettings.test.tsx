import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSetting, AdminSettings as AdminSettingsData } from "../../api";
import { ApiError } from "../../api/client";
import AdminSettings from "./AdminSettings";
import { SudoProvider } from "./SudoContext";

const mocks = vi.hoisted(() => ({
  getAdminSettings: vi.fn(),
  adminSetSetting: vi.fn(),
  adminResetSetting: vi.fn(),
  adminSudo: vi.fn(),
}));
vi.mock("../../api", () => mocks);

const setting = (key: string, over: Partial<AdminSetting> = {}): AdminSetting => ({
  key,
  group: "server",
  kind: "boolean",
  choices: null,
  value: "false",
  source: "default",
  locked: false,
  default: "false",
  updatedAt: null,
  problem: null,
  ...over,
});
const answer = (settings: AdminSetting[], warnings: string[] = []): AdminSettingsData => ({ settings, warnings });

const SETTINGS = [
  setting("LINK_PREVIEWS_ENABLED"),
  setting("FEDERATION_ENABLED", { group: "federation", value: "true", default: "true", source: "environment", locked: true }),
  setting("FEDERATION_CONTACT_POLICY_LIMIT", { group: "people", kind: "choice", choices: ["ANYONE", "SHARED_COMMUNITY", "LOCAL_ONLY"], value: "ANYONE", default: "ANYONE" }),
  setting("FEDERATION_BLOCKED_DOMAINS", { group: "federation", kind: "domains", value: "a.example.com,b.example.com", default: "", source: "database", updatedAt: "2026-11-01T00:00:00.000Z" }),
  setting("SERVER_NAME", { kind: "text", value: "Our Place", default: "My Chat Server", source: "database", updatedAt: "2026-11-01T00:00:00.000Z" }),
];

const show = () =>
  render(
    <SudoProvider>
      <AdminSettings />
    </SudoProvider>
  );
const rowOf = (name: string | RegExp) => screen.getByLabelText(name).closest("li") as HTMLElement;
async function confirmSudo() {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "pw" } });
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm it is you" })).toBeNull());
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getAdminSettings.mockResolvedValue(answer(SETTINGS));
  mocks.adminSudo.mockResolvedValue({ sudoToken: "sudo-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
});
afterEach(cleanup);

describe("what is shown", () => {
  it("lists each setting under its group, in words, with where its value comes from", async () => {
    show();
    await screen.findByLabelText("Link previews");
    expect(screen.getByRole("region", { name: "This server" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Other servers" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "People" })).toBeTruthy();
    expect(rowOf("Link previews").textContent).toContain("Default: Off");
    expect(rowOf("Server name").textContent).toContain("Changed here");
    expect((screen.getByLabelText("Server name") as HTMLInputElement).value).toBe("Our Place");
    expect((screen.getByLabelText("Never talk to these servers") as HTMLTextAreaElement).value).toBe("a.example.com\nb.example.com");
    expect(within(rowOf("Link previews")).getByRole("option", { name: "On" })).toBeTruthy();
    expect(within(rowOf("The widest anyone may allow")).getByRole("option", { name: "People on this server" })).toBeTruthy();
  });

  it("locks a setting the environment sets: shown, no way to change it, and says where to change it", async () => {
    show();
    const select = (await screen.findByLabelText("Talk to other servers")) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("true");
    const row = rowOf("Talk to other servers");
    expect(row.textContent).toContain("Set by the server's environment");
    expect(row.textContent).toContain("FEDERATION_ENABLED");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("shows the server's warnings, and a stored value that is not in use", async () => {
    mocks.getAdminSettings.mockResolvedValue(answer([setting("LINK_PREVIEWS_ENABLED", { problem: 'LINK_PREVIEWS_ENABLED is "maybe"' })], ["The stored settings cannot all hold at once."]));
    show();
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("cannot all hold at once");
    expect(screen.getByRole("note").textContent).toContain("not in use");
  });

  it("says when the settings cannot be loaded", async () => {
    mocks.getAdminSettings.mockRejectedValue(new Error("down"));
    show();
    expect(await screen.findByText("Couldn't load the settings. Try again.")).toBeTruthy();
  });
});

describe("changing one", () => {
  it("offers Save only when the box differs, then asks for sudo mode and stores the change", async () => {
    const changed = setting("LINK_PREVIEWS_ENABLED", { value: "true", source: "database", updatedAt: "2026-11-03T00:00:00.000Z" });
    mocks.adminSetSetting.mockResolvedValue({ setting: changed });
    // The page asks again after a change, and the server now has the new value.
    mocks.getAdminSettings.mockResolvedValueOnce(answer(SETTINGS)).mockResolvedValue(answer([changed, ...SETTINGS.slice(1)]));
    show();
    const select = await screen.findByLabelText("Link previews");
    const save = within(rowOf("Link previews")).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(select, { target: { value: "true" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await confirmSudo();
    await waitFor(() => expect(mocks.adminSetSetting).toHaveBeenCalledWith("LINK_PREVIEWS_ENABLED", "true", "sudo-1"));
    await waitFor(() => expect(rowOf("Link previews").textContent).toContain("Changed here"));
    expect(within(rowOf("Link previews")).getByRole("status").textContent).toBe("Saved.");
  });

  it("sends a list the way the server keeps it: one entry each, however it was typed", async () => {
    mocks.adminSetSetting.mockResolvedValue({ setting: setting("FEDERATION_BLOCKED_DOMAINS", { kind: "domains", value: "c.example.com", source: "database" }) });
    show();
    fireEvent.change(await screen.findByLabelText("Never talk to these servers"), { target: { value: " c.example.com \n\n" } });
    fireEvent.click(within(rowOf("Never talk to these servers")).getByRole("button", { name: "Save" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminSetSetting).toHaveBeenCalledWith("FEDERATION_BLOCKED_DOMAINS", "c.example.com", "sudo-1"));
  });

  it("shows the server's own words when it refuses a value, and keeps what was typed", async () => {
    mocks.adminSetSetting.mockRejectedValue(new ApiError(409, { error: "conflicts_with_another_setting", message: 'FEDERATION_ALLOWED_DOMAINS and FEDERATION_BLOCKED_DOMAINS both list "a.example.com".' }));
    show();
    const box = (await screen.findByLabelText("Never talk to these servers")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "a.example.com" } });
    fireEvent.click(within(rowOf("Never talk to these servers")).getByRole("button", { name: "Save" }));
    await confirmSudo();
    const alert = await within(rowOf("Never talk to these servers")).findByRole("alert");
    expect(alert.textContent).toContain("both list");
    expect(box.value).toBe("a.example.com");
  });

  it("explains a refusal because the environment sets it, in words and not as a code", async () => {
    mocks.adminSetSetting.mockRejectedValue(new ApiError(409, { error: "locked_by_environment", message: "x" }));
    show();
    fireEvent.change(await screen.findByLabelText("Link previews"), { target: { value: "true" } });
    fireEvent.click(within(rowOf("Link previews")).getByRole("button", { name: "Save" }));
    await confirmSudo();
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be changed here");
  });

  it("does nothing, and says nothing, when sudo mode is backed out of", async () => {
    show();
    fireEvent.change(await screen.findByLabelText("Link previews"), { target: { value: "true" } });
    fireEvent.click(within(rowOf("Link previews")).getByRole("button", { name: "Save" }));
    fireEvent.click(await within(await screen.findByRole("dialog", { name: "Confirm it is you" })).findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.adminSetSetting).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("going back to the default", () => {
  it("is offered only for what was changed here, names the default, and asks for sudo mode", async () => {
    mocks.adminResetSetting.mockResolvedValue({ setting: setting("SERVER_NAME", { kind: "text", value: "My Chat Server", default: "My Chat Server" }) });
    show();
    await screen.findByLabelText("Server name");
    expect(within(rowOf("Link previews")).queryByRole("button", { name: /Back to the default/ })).toBeNull();
    fireEvent.click(within(rowOf("Server name")).getByRole("button", { name: "Back to the default (My Chat Server)" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminResetSetting).toHaveBeenCalledWith("SERVER_NAME", "sudo-1"));
  });
});

describe("a change that moves another setting", () => {
  it("looks at all of them again, and keeps a box the person is still typing in", async () => {
    mocks.adminSetSetting.mockResolvedValue({ setting: setting("LINK_PREVIEWS_ENABLED", { value: "true", source: "database" }) });
    show();
    const name = (await screen.findByLabelText("Server name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Half typed" } });
    fireEvent.change(screen.getByLabelText("Link previews"), { target: { value: "true" } });
    fireEvent.click(within(rowOf("Link previews")).getByRole("button", { name: "Save" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.getAdminSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect((screen.getByLabelText("Server name") as HTMLInputElement).value).toBe("Half typed");
  });
});
