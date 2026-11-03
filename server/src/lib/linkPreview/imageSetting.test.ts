import { describe, expect, it } from "vitest";
import { parseLinkPreviewImagesEnabled } from "./imageSetting.js";

describe("LINK_PREVIEW_IMAGES_ENABLED", () => {
  it("is off when unset or empty, so a server that never heard of it keeps nothing", () => {
    for (const value of [undefined, "", "   "]) expect(parseLinkPreviewImagesEnabled(value), String(value)).toBe(false);
  });

  it("accepts the usual spellings of yes and no, in any case", () => {
    for (const value of ["true", "TRUE", "1", "yes", "On", " on "]) expect(parseLinkPreviewImagesEnabled(value), value).toBe(true);
    for (const value of ["false", "False", "0", "no", "OFF"]) expect(parseLinkPreviewImagesEnabled(value), value).toBe(false);
  });

  it("refuses anything else instead of guessing, and says which variable and what is accepted", () => {
    for (const value of ["fasle", "tru", "2", "enabled", "yes please"]) {
      expect(() => parseLinkPreviewImagesEnabled(value), value).toThrow(/LINK_PREVIEW_IMAGES_ENABLED is ".*", which is not true or false/);
    }
  });
});
