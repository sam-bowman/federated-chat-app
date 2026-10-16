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

import { addReaction, removeReaction } from "./index";

beforeEach(() => apiRequest.mockReset().mockResolvedValue({ message: {} }));

const party = { id: "01HZ/PARTY", name: "Party", imageUrl: "https://cdn.example/party.png" };

describe("reactions", () => {
  it("adds an emoji by the emoji, and an emoticon by its id (never its trigger or picture)", async () => {
    await addReaction("m1", { emoji: "👍" });
    await addReaction("m1", { emoticon: party });

    expect(apiRequest.mock.calls[0]).toEqual(["/api/v1/messages/m1/reactions", { method: "POST", body: { emoji: "👍" } }]);
    expect(apiRequest.mock.calls[1]).toEqual(["/api/v1/messages/m1/reactions", { method: "POST", body: { emoticonId: "01HZ/PARTY" } }]);
  });

  it("takes an emoji back on the emoji's own address, and an emoticon on its own", async () => {
    await removeReaction("m1", { emoji: "👍" });
    await removeReaction("m1", { emoticon: party });

    expect(apiRequest.mock.calls[0]).toEqual(["/api/v1/messages/m1/reactions/%F0%9F%91%8D", { method: "DELETE" }]);
    // The id is encoded into the path, so a slash in it cannot become another path segment.
    expect(apiRequest.mock.calls[1]).toEqual(["/api/v1/messages/m1/emoticon-reactions/01HZ%2FPARTY", { method: "DELETE" }]);
  });
});
