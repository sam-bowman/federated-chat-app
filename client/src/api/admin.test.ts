import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("./client", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  mediaUrl: vi.fn(),
  wsUrl: vi.fn(),
  getAccessToken: vi.fn(),
}));

import {
  adminCancelDeletion,
  adminCreateRegistrationInvites,
  adminDeleteCommunity,
  adminDeleteUser,
  adminDisableTwoFactor,
  adminResetPassword,
  adminRevokeRegistrationInvite,
  adminSetAdmin,
  adminSudo,
  adminSuspend,
  adminTransferCommunity,
  adminUnsuspend,
  getAdminCommunity,
  getAdminUser,
  listAdminCommunities,
  listAdminRegistrationInvites,
  listAdminUsers,
} from "./index";

beforeEach(() => apiRequest.mockReset().mockResolvedValue({}));

describe("the admin page's calls", () => {
  it("confirming it is you sends no sudo token (it is how you get one)", async () => {
    await adminSudo({ password: "pw", code: "123456" });
    expect(apiRequest).toHaveBeenCalledWith("/api/v1/admin/sudo", { method: "POST", body: { password: "pw", code: "123456" } });
  });

  it("every call that changes an account sends the sudo token, in the right header, to the right place", async () => {
    await adminSuspend("bob", "tok");
    await adminUnsuspend("bob", "tok");
    await adminResetPassword("bob", "New-Passw0rd!", "tok");
    await adminDisableTwoFactor("bob", "tok");
    await adminCancelDeletion("bob", "tok");
    await adminDeleteUser("bob", { now: true, confirm: "bob" }, "tok");
    await adminSetAdmin("bob", true, "tok");

    const sent = apiRequest.mock.calls.map(([path, options]) => ({ path, method: options.method, body: options.body, header: options.headers }));
    expect(sent).toEqual([
      { path: "/api/v1/admin/users/bob/suspend", method: "POST", body: {}, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/users/bob/unsuspend", method: "POST", body: {}, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/users/bob/reset-password", method: "POST", body: { password: "New-Passw0rd!" }, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/users/bob/disable-2fa", method: "POST", body: {}, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/users/bob/cancel-deletion", method: "POST", body: {}, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/users/bob/delete", method: "POST", body: { now: true, confirm: "bob" }, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/users/bob/admin", method: "PUT", body: { admin: true }, header: { "X-Admin-Sudo": "tok" } },
    ]);
  });

  it("puts a username into the address as one piece, whatever is in it", async () => {
    await adminSuspend("a/b?c#d", "tok");
    await getAdminUser("a/b?c#d");
    expect(apiRequest.mock.calls[0][0]).toBe("/api/v1/admin/users/a%2Fb%3Fc%23d/suspend");
    expect(apiRequest.mock.calls[1][0]).toBe("/api/v1/admin/users/a%2Fb%3Fc%23d");
  });

  it("looking does not send the sudo token: it is only for what changes something", async () => {
    await getAdminUser("bob");
    await listAdminUsers({ search: "x" });
    for (const [, options] of apiRequest.mock.calls) expect(options?.headers).toBeUndefined();
  });

  it("asks for a page with only the options that were set", async () => {
    await listAdminUsers();
    await listAdminUsers({ search: "rob", suspended: true, admin: false, offset: 25, limit: 25 });
    await listAdminUsers({ search: "", suspended: false, admin: undefined, offset: 0 });
    expect(apiRequest.mock.calls[0][0]).toBe("/api/v1/admin/users");
    // `false` and an empty search are not sent: they mean "no filter", and the server reads "admin=false" as "only people who are not".
    expect(apiRequest.mock.calls[1][0]).toBe("/api/v1/admin/users?search=rob&suspended=true&offset=25&limit=25");
    expect(apiRequest.mock.calls[2][0]).toBe("/api/v1/admin/users?offset=0");
  });
});

describe("the admin page's registration invite calls", () => {
  it("making and revoking send the sudo token, in the right header, to the right place, with what was chosen", async () => {
    await adminCreateRegistrationInvites({ maxUses: null, expiresInDays: 30, note: "Alex", count: 2 }, "tok");
    await adminRevokeRegistrationInvite("some-id", "tok");
    const sent = apiRequest.mock.calls.map(([path, options]) => ({ path, method: options.method, body: options.body, header: options.headers }));
    expect(sent).toEqual([
      { path: "/api/v1/admin/registration-invites", method: "POST", body: { maxUses: null, expiresInDays: 30, note: "Alex", count: 2 }, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/registration-invites/some-id/revoke", method: "POST", body: {}, header: { "X-Admin-Sudo": "tok" } },
    ]);
  });

  it("names an invite by its id in the address as one piece, never by its code", async () => {
    await adminRevokeRegistrationInvite("a/b?c#d", "tok");
    expect(apiRequest.mock.calls[0][0]).toBe("/api/v1/admin/registration-invites/a%2Fb%3Fc%23d/revoke");
  });

  it("looking sends no sudo token, and asks for the codes that are over only when told to", async () => {
    await listAdminRegistrationInvites();
    await listAdminRegistrationInvites(false);
    await listAdminRegistrationInvites(true);
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/registration-invites",
      "/api/v1/admin/registration-invites",
      "/api/v1/admin/registration-invites?all=1",
    ]);
    for (const [, options] of apiRequest.mock.calls) expect(options?.headers).toBeUndefined();
  });
});

describe("the admin page's community calls", () => {
  it("handing one on and deleting one send the sudo token, in the right header, to the right place, with what was typed", async () => {
    await adminTransferCommunity("c1", "carol", "tok");
    await adminDeleteCommunity("c1", "Book Club", "tok");
    const sent = apiRequest.mock.calls.map(([path, options]) => ({ path, method: options.method, body: options.body, header: options.headers }));
    expect(sent).toEqual([
      { path: "/api/v1/admin/communities/c1/owner", method: "PUT", body: { username: "carol" }, header: { "X-Admin-Sudo": "tok" } },
      { path: "/api/v1/admin/communities/c1/delete", method: "POST", body: { confirm: "Book Club" }, header: { "X-Admin-Sudo": "tok" } },
    ]);
  });

  it("puts a community's id into the address as one piece, whatever is in it", async () => {
    await adminTransferCommunity("a/b?c#d", "carol", "tok");
    await adminDeleteCommunity("a/b?c#d", "x", "tok");
    await getAdminCommunity("a/b?c#d");
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/communities/a%2Fb%3Fc%23d/owner",
      "/api/v1/admin/communities/a%2Fb%3Fc%23d/delete",
      "/api/v1/admin/communities/a%2Fb%3Fc%23d",
    ]);
  });

  it("looking does not send the sudo token: it is only for what changes something", async () => {
    await getAdminCommunity("c1");
    await listAdminCommunities({ search: "x" });
    for (const [, options] of apiRequest.mock.calls) expect(options?.headers).toBeUndefined();
  });

  it("asks for a page with only the options that were set", async () => {
    await listAdminCommunities();
    await listAdminCommunities({ search: "club", offset: 25, limit: 25 });
    await listAdminCommunities({ search: "", offset: 0 });
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/communities",
      "/api/v1/admin/communities?search=club&offset=25&limit=25",
      "/api/v1/admin/communities?offset=0",
    ]);
  });
});
