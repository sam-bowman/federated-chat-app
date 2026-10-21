import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
const setTokens = vi.fn();
vi.mock("./client", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  setTokens: (...args: unknown[]) => setTokens(...args),
  clearTokens: vi.fn(),
  mediaUrl: vi.fn(),
  wsUrl: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { dismissDeletionCancelled } from "../lib/deletionNotice";
import { deleteMyAccount, login, verifyTotpLogin } from "./index";

const signedIn = { user: { id: "u1", username: "alice" }, accessToken: "a", refreshToken: "r" };
let announced = false;

beforeEach(() => {
  apiRequest.mockReset();
  setTokens.mockReset();
  dismissDeletionCancelled();
  announced = false;
});
afterEach(dismissDeletionCancelled);

/** Whether the notice store was told, read the way a component does. */
async function noticeShown(): Promise<boolean> {
  const { useDeletionCancelled } = await import("../lib/deletionNotice");
  const { renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(() => useDeletionCancelled());
  const value = result.current;
  unmount();
  announced = value;
  return value;
}

describe("asking for the account to be deleted", () => {
  it("sends what proves it is the person, and gives back when it will happen", async () => {
    apiRequest.mockResolvedValue({ scheduledFor: "2026-02-01T00:00:00.000Z", graceDays: 14 });
    const result = await deleteMyAccount({ password: "pw", username: "alice", code: "123456" });
    expect(apiRequest).toHaveBeenCalledWith("/api/v1/users/me/delete", { method: "POST", body: { password: "pw", username: "alice", code: "123456" } });
    expect(result).toEqual({ scheduledFor: "2026-02-01T00:00:00.000Z", graceDays: 14 });
  });
});

describe("signing in to an account that was going to be deleted", () => {
  it("tells the person it was cancelled, after a plain sign-in", async () => {
    apiRequest.mockResolvedValue({ ...signedIn, deletionCancelled: true });
    expect(await login("alice", "pw")).toEqual(signedIn.user);
    expect(await noticeShown()).toBe(true);
  });

  it("and after the second step of a two-factor sign-in", async () => {
    apiRequest.mockResolvedValue({ ...signedIn, deletionCancelled: true });
    await verifyTotpLogin("challenge", { code: "123456" });
    expect(await noticeShown()).toBe(true);
  });

  it("says nothing on an ordinary sign-in, or while a two-factor sign-in is only half done", async () => {
    apiRequest.mockResolvedValue(signedIn);
    await login("alice", "pw");
    apiRequest.mockResolvedValue({ totpRequired: true, challengeToken: "c" });
    await login("alice", "pw");
    expect(await noticeShown()).toBe(false);
    expect(announced).toBe(false);
  });
});
