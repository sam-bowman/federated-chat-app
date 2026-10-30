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

import { getOpenReportCount, getReportContext } from "./index";

beforeEach(() => apiRequest.mockReset().mockResolvedValue({}));

describe("the counts and the context of reports (#296)", () => {
  it("asks a community for its own number, and the admins' queue for theirs", async () => {
    await getOpenReportCount("C1");
    await getOpenReportCount(null);

    expect(apiRequest.mock.calls[0]).toEqual(["/api/v1/communities/C1/reports/open-count"]);
    expect(apiRequest.mock.calls[1]).toEqual(["/api/v1/admin/reports/open-count"]);
  });

  it("asks a community for the messages around a report, with the report's id encoded into the path", async () => {
    await getReportContext("C1", "r/1");

    expect(apiRequest.mock.calls[0]).toEqual(["/api/v1/communities/C1/reports/r%2F1/context"]);
  });
});
