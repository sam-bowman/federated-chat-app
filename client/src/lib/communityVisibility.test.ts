import { describe, expect, it } from "vitest";
import type { Community } from "../api";
import { VISIBILITY_CHOICES, isLocalOnly, visibilityOf } from "./communityVisibility";

const of = (over: { visibility?: Community["visibility"]; openJoin?: boolean }) => over as Pick<Community, "visibility" | "openJoin">;

describe("the choices", () => {
  // These are the names the server accepts (server/src/lib/communityVisibility.ts); one it does not know is a 400.
  it("are exactly the three the server knows, with the open one first", () => {
    expect(VISIBILITY_CHOICES.map((c) => c.value)).toEqual(["UNLISTED", "INVITE_ONLY", "LOCAL_ONLY"]);
  });
});

describe("visibilityOf", () => {
  it("is what the server says", () => {
    for (const visibility of ["UNLISTED", "INVITE_ONLY", "LOCAL_ONLY"] as const) expect(visibilityOf(of({ visibility }))).toBe(visibility);
  });

  it("is worked out from the old yes/no when the server predates the setting, and is open when it says nothing at all", () => {
    expect(visibilityOf(of({ openJoin: false }))).toBe("INVITE_ONLY");
    expect(visibilityOf(of({ openJoin: true }))).toBe("UNLISTED");
    expect(visibilityOf(of({}))).toBe("UNLISTED");
  });

  it("goes by the setting over the old yes/no when both are there, as a local-only community also says openJoin: true", () => {
    expect(visibilityOf(of({ visibility: "LOCAL_ONLY", openJoin: true }))).toBe("LOCAL_ONLY");
    expect(visibilityOf(of({ visibility: "INVITE_ONLY", openJoin: true }))).toBe("INVITE_ONLY");
  });
});

describe("isLocalOnly", () => {
  it("is true only for a community that takes just its own server", () => {
    expect(isLocalOnly(of({ visibility: "LOCAL_ONLY" }))).toBe(true);
    expect(isLocalOnly(of({ visibility: "UNLISTED" }))).toBe(false);
    expect(isLocalOnly(of({ openJoin: false }))).toBe(false);
  });
});
