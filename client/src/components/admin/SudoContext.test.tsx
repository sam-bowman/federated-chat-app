import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { SudoCancelled, SudoProvider, useSudo } from "./SudoContext";

const mocks = vi.hoisted(() => ({ adminSudo: vi.fn() }));
vi.mock("../../api", () => ({ adminSudo: mocks.adminSudo }));

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

let sudo!: ReturnType<typeof useSudo>;
function Probe() {
  sudo = useSudo();
  return <span>{sudo.confirmedUntil ? "confirmed" : "not confirmed"}</span>;
}
const show = () =>
  render(
    <SudoProvider>
      <Probe />
    </SudoProvider>
  );

const fillAndConfirm = async (password = "pw", code = "123456") => {
  fireEvent.change(await screen.findByLabelText("Your password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/Code from your authenticator app/), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
};

beforeEach(() => {
  mocks.adminSudo.mockReset().mockResolvedValue({ sudoToken: "token-1", expiresAt: later(10 * 60_000) });
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("sudo mode", () => {
  it("asks for the password and a code before doing the first thing, then does it with the token", async () => {
    show();
    const action = vi.fn().mockResolvedValue("done");
    let result: Promise<string>;
    act(() => {
      result = sudo.run(action);
    });
    expect(await screen.findByRole("dialog", { name: "Confirm it is you" })).toBeTruthy();
    expect(action).not.toHaveBeenCalled();

    await fillAndConfirm();
    await expect(result!).resolves.toBe("done");
    expect(mocks.adminSudo).toHaveBeenCalledWith({ password: "pw", code: "123456" });
    expect(action).toHaveBeenCalledWith("token-1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("confirmed")).toBeTruthy();
  });

  it("does not ask again while the confirmation lasts", async () => {
    show();
    act(() => void sudo.run(async () => 1));
    await fillAndConfirm();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const second = vi.fn().mockResolvedValue(2);
    await act(async () => {
      await sudo.run(second);
    });
    expect(second).toHaveBeenCalledWith("token-1");
    expect(mocks.adminSudo).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks again once it has run out, or is about to", async () => {
    mocks.adminSudo.mockResolvedValueOnce({ sudoToken: "short", expiresAt: later(5_000) }).mockResolvedValueOnce({ sudoToken: "fresh", expiresAt: later(600_000) });
    show();
    act(() => void sudo.run(async () => 1));
    await fillAndConfirm();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Less than ten seconds left is treated as gone, so an action never starts with a token that runs out on the way.
    const action = vi.fn().mockResolvedValue("ok");
    act(() => void sudo.run(action));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await fillAndConfirm();
    await waitFor(() => expect(action).toHaveBeenCalledWith("fresh"));
  });

  it("asks again, once, when the server says the token is no good, and tries the action again", async () => {
    mocks.adminSudo.mockResolvedValueOnce({ sudoToken: "stale", expiresAt: later(600_000) }).mockResolvedValueOnce({ sudoToken: "fresh", expiresAt: later(600_000) });
    show();
    const action = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(403, { error: "sudo_required" }))
      .mockResolvedValueOnce("worked");
    let result: Promise<string>;
    act(() => {
      result = sudo.run(action);
    });
    await fillAndConfirm();
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    // The server refused the token, so it is asked for again: a new dialog, empty, not the last one with its old words.
    await waitFor(() => expect(mocks.adminSudo).toHaveBeenCalledTimes(1));
    const password = (await screen.findByLabelText("Your password")) as HTMLInputElement;
    await waitFor(() => expect(password.value).toBe(""));
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    await fillAndConfirm();
    await expect(result!).resolves.toBe("worked");
    expect(action).toHaveBeenNthCalledWith(1, "stale");
    expect(action).toHaveBeenNthCalledWith(2, "fresh");
  });

  it("does not retry for any other refusal, and passes it on", async () => {
    show();
    act(() => void sudo.run(async () => 1));
    await fillAndConfirm();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const refused = new ApiError(409, { error: "target_is_admin" });
    await expect(sudo.run(() => Promise.reject(refused))).rejects.toBe(refused);
    expect(mocks.adminSudo).toHaveBeenCalledOnce();
  });

  it("does nothing when they back out, and says so with an error that is not shown as one", async () => {
    show();
    const action = vi.fn();
    let result: Promise<unknown>;
    act(() => {
      result = sudo.run(action);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(result!).rejects.toBeInstanceOf(SudoCancelled);
    expect(action).not.toHaveBeenCalled();
    expect(mocks.adminSudo).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("not confirmed")).toBeTruthy();
  });

  it("shares one question between actions started together", async () => {
    show();
    const a = vi.fn().mockResolvedValue("a");
    const b = vi.fn().mockResolvedValue("b");
    let both: Promise<unknown[]>;
    act(() => {
      both = Promise.all([sudo.run(a), sudo.run(b)]);
    });
    expect(await screen.findAllByRole("dialog")).toHaveLength(1);
    await fillAndConfirm();
    await expect(both!).resolves.toEqual(["a", "b"]);
    expect(mocks.adminSudo).toHaveBeenCalledOnce();
  });

  it("stays open and says why when the password or the code is wrong, and lets them try again", async () => {
    mocks.adminSudo.mockRejectedValueOnce(new ApiError(401, { error: "invalid_credentials" })).mockRejectedValueOnce(new ApiError(401, { error: "invalid_code" }));
    show();
    const action = vi.fn().mockResolvedValue(1);
    act(() => void sudo.run(action));
    await fillAndConfirm("wrong");
    expect(await screen.findByText("That is not your password.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/That code is not right/)).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("token-1"));
  });

  it("sends six digits as a code and anything longer as a recovery code", async () => {
    show();
    act(() => void sudo.run(async () => 1));
    await fillAndConfirm("pw", " abcd-efgh-ijkl ");
    await waitFor(() => expect(mocks.adminSudo).toHaveBeenCalledWith({ password: "pw", recoveryCode: "abcd-efgh-ijkl" }));
  });

  it("needs both fields before it will confirm", async () => {
    show();
    act(() => void sudo.run(async () => 1));
    const confirm = (await screen.findByRole("button", { name: "Confirm" })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "pw" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
    expect(confirm.disabled).toBe(false);
  });

  it("keeps the token in memory only: nothing is written to storage", async () => {
    show();
    act(() => void sudo.run(async () => 1));
    await fillAndConfirm();
    await waitFor(() => expect(screen.getByText("confirmed")).toBeTruthy());
    const everything = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(everything).not.toContain("token-1");
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("is only available inside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useSudo needs a SudoProvider");
    spy.mockRestore();
  });
});
