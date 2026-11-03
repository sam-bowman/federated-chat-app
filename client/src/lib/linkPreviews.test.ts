import { afterEach, describe, expect, it, vi } from "vitest";
import { linkPreviewPicturesShown, linkPreviewsShown, previewHost, previewHref, previewPicture, setLinkPreviewPicturesShown, setLinkPreviewsShown } from "./linkPreviews";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the picture setting (#244)", () => {
  afterEach(() => localStorage.clear());

  it("is on unless the person turned it off, and remembers that", () => {
    expect(linkPreviewPicturesShown()).toBe(true);
    setLinkPreviewPicturesShown(false);
    expect(localStorage.getItem("chat.linkPreviewPictures")).toBe("hide");
    expect(linkPreviewPicturesShown()).toBe(false);
    setLinkPreviewPicturesShown(true);
    expect(localStorage.getItem("chat.linkPreviewPictures")).toBeNull();
    expect(linkPreviewPicturesShown()).toBe(true);
  });

  it("is separate from the choice to show previews at all", () => {
    setLinkPreviewPicturesShown(false);
    expect(linkPreviewsShown()).toBe(true);
    setLinkPreviewPicturesShown(true);
    setLinkPreviewsShown(false);
    expect(linkPreviewPicturesShown()).toBe(true);
    setLinkPreviewsShown(true);
  });

  it("is on when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(linkPreviewPicturesShown()).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("previewPicture", () => {
  const ok = { url: "https://chat.example/uploads/a.png", width: 640, height: 480 };

  it("is the address and size of a plain http(s) picture of a sane size", () => {
    expect(previewPicture(ok)).toEqual({ src: "https://chat.example/uploads/a.png", width: 640, height: 480 });
    expect(previewPicture({ ...ok, url: "http://chat.example/a.png" })?.src).toBe("http://chat.example/a.png");
    expect(previewPicture({ ...ok, width: 4096, height: 1 })).not.toBeNull();
  });

  it("is nothing for anything else", () => {
    for (const bad of [null, undefined, "x", 5, [], {}, { ...ok, url: "javascript:alert(1)" }, { ...ok, url: "https://u:p@chat.example/a.png" }, { ...ok, url: "/a.png" }, { ...ok, width: 0 }, { ...ok, width: 4097 }, { ...ok, height: 2.5 }, { ...ok, height: "5" }, { url: ok.url }]) {
      expect(previewPicture(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("previewHref", () => {
  it("accepts plain http and https addresses and gives back the parsed address", () => {
    expect(previewHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(previewHref("http://example.com")).toBe("http://example.com/");
  });

  it("refuses everything that is not a plain web address", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://example.com", "//example.com", "example.com", "", "not a url"]) {
      expect(previewHref(url), url).toBeNull();
    }
  });

  it("refuses an address with a name or password in it, which can pass for another site", () => {
    expect(previewHref("https://paypal.com@evil.example/")).toBeNull();
    expect(previewHref("https://user:pass@example.com/")).toBeNull();
  });

  it("refuses what is not a string, since a peer's answer is not trusted to be one", () => {
    for (const url of [null, undefined, 7, {}, ["https://example.com"]]) expect(previewHref(url)).toBeNull();
  });
});

describe("previewHost", () => {
  it("is the address's own host without www", () => {
    expect(previewHost("https://www.Example.com/a")).toBe("example.com");
    expect(previewHost("https://docs.example.com:8443/")).toBe("docs.example.com");
  });
});

describe("the choice to show previews", () => {
  it("shows them unless the person turned them off, and remembers the choice", () => {
    expect(linkPreviewsShown()).toBe(true);
    setLinkPreviewsShown(false);
    expect(linkPreviewsShown()).toBe(false);
    setLinkPreviewsShown(true);
    expect(linkPreviewsShown()).toBe(true);
    expect(localStorage.getItem("chat.linkPreviews")).toBeNull();
  });

  it("shows them when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(linkPreviewsShown()).toBe(true);
  });

  it("does not throw when the choice cannot be saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setLinkPreviewsShown(false)).not.toThrow();
  });
});
