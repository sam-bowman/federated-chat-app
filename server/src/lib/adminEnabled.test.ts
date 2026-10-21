import { describe, expect, it } from "vitest";
import { parseAdminEnabled } from "./adminEnabled.js";

describe("parseAdminEnabled", () => {
  it("is on when unset or empty: it exposes nothing until an admin is made", () => {
    expect(parseAdminEnabled(undefined)).toBe(true);
    expect(parseAdminEnabled("")).toBe(true);
    expect(parseAdminEnabled("  ")).toBe(true);
  });

  it("takes the usual spellings of yes and no, in any case", () => {
    for (const yes of ["true", "1", "yes", "on", "TRUE", " On "]) expect(parseAdminEnabled(yes), yes).toBe(true);
    for (const no of ["false", "0", "no", "off", "FALSE", " Off "]) expect(parseAdminEnabled(no), no).toBe(false);
  });

  it("refuses anything else, so a typo cannot leave the admin surface on", () => {
    for (const bad of ["fasle", "disabled", "2", "tru", "enabled"]) expect(() => parseAdminEnabled(bad), bad).toThrow(/ADMIN_ENABLED.*not true or false/s);
  });
});
