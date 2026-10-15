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

import { createInvite, joinCommunity, listInvites, revokeInvite, updateCommunity } from "./index";

beforeEach(() => {
  apiRequest.mockReset().mockResolvedValue({ community: { id: "C1" }, invite: { code: "X" }, invites: [], seesAll: false });
});

describe("joinCommunity", () => {
  // The bug this guards: a "#" in a URL starts the fragment, which is never sent, so "<id>:<server>#<code>" arrived as
  // "<id>:<server>" and the invite was silently dropped. The reference has to be encoded into the path.
  it("encodes the whole reference, so the invite after a # reaches the server", async () => {
    await joinCommunity("01JABC:far.example#K7M2QXR9TB");

    const [path, options] = apiRequest.mock.calls[0];
    expect(path).toBe("/api/v1/communities/01JABC%3Afar.example%23K7M2QXR9TB/members");
    expect(path).not.toContain("#");
    expect(options).toEqual({ method: "POST" });
  });

  it("round-trips: what the server decodes from the path is what was given", async () => {
    const reference = "01JABC:localhost:4001#K7M2QXR9TB";

    await joinCommunity(reference);

    const path = apiRequest.mock.calls[0][0] as string;
    expect(decodeURIComponent(path.split("/communities/")[1].replace("/members", ""))).toBe(reference);
  });

  it("works for a bare id and returns the community", async () => {
    const community = await joinCommunity("01JABC");

    expect(apiRequest.mock.calls[0][0]).toBe("/api/v1/communities/01JABC/members");
    expect(community).toEqual({ id: "C1" });
  });

  it("cannot be talked into another path by what is typed", async () => {
    await joinCommunity("../../auth/logout?x=1");

    const path = apiRequest.mock.calls[0][0] as string;
    expect(path.startsWith("/api/v1/communities/")).toBe(true);
    expect(path.endsWith("/members")).toBe(true);
    expect(path.slice("/api/v1/communities/".length, -"/members".length)).not.toMatch(/[/?]/);
  });
});

describe("the invite calls", () => {
  it("createInvite sends the options as the body, nulls included, and returns the invite", async () => {
    const invite = await createInvite("C1", { expiresInSeconds: 3600, maxUses: null });

    expect(apiRequest).toHaveBeenCalledWith("/api/v1/communities/C1/invites", { method: "POST", body: { expiresInSeconds: 3600, maxUses: null } });
    expect(invite).toEqual({ code: "X" });
  });

  it("createInvite with no options sends an empty body", async () => {
    await createInvite("C1");

    expect(apiRequest.mock.calls[0][1]).toEqual({ method: "POST", body: {} });
  });

  it("listInvites reads the community's invites and whether the viewer sees everyone's", async () => {
    const result = await listInvites("C1");

    expect(apiRequest).toHaveBeenCalledWith("/api/v1/communities/C1/invites");
    expect(result).toMatchObject({ invites: [], seesAll: false });
  });

  it("revokeInvite deletes one invite of one community", async () => {
    await revokeInvite("C1", "inv9");

    expect(apiRequest).toHaveBeenCalledWith("/api/v1/communities/C1/invites/inv9", { method: "DELETE" });
  });

  it("updateCommunity can close and open a community to joining by id", async () => {
    await updateCommunity("C1", { openJoin: false });

    expect(apiRequest).toHaveBeenCalledWith("/api/v1/communities/C1", { method: "PATCH", body: { openJoin: false } });
  });
});
