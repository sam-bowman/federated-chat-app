import { describe, expect, it } from "vitest";
import { parseAccentColor, parsePronouns, PRONOUNS_MAX_CHARACTERS, sanitizeRemoteProfile } from "./profileFields.js";

describe("parsePronouns", () => {
  it("keeps ordinary pronouns, trimmed", () => {
    expect(parsePronouns("  she/her ")).toEqual({ ok: true, value: "she/her" });
    expect(parsePronouns("they/them")).toEqual({ ok: true, value: "they/them" });
  });

  it("treats empty, spaces only and null as none", () => {
    expect(parsePronouns("")).toEqual({ ok: true, value: null });
    expect(parsePronouns("   ")).toEqual({ ok: true, value: null });
    expect(parsePronouns(null)).toEqual({ ok: true, value: null });
  });

  it("allows exactly the maximum and rejects one more, counting whole characters", () => {
    expect(parsePronouns("a".repeat(PRONOUNS_MAX_CHARACTERS)).ok).toBe(true);
    expect(parsePronouns("a".repeat(PRONOUNS_MAX_CHARACTERS + 1)).ok).toBe(false);
    // An emoji with a skin tone is one character to a person, though several UTF-16 units.
    expect(parsePronouns("👍🏽".repeat(PRONOUNS_MAX_CHARACTERS)).ok).toBe(true);
  });

  it("rejects control characters, line breaks and anything that is not text", () => {
    expect(parsePronouns("she\nher").ok).toBe(false);
    expect(parsePronouns("she\u0000her").ok).toBe(false);
    expect(parsePronouns("she her").ok).toBe(false);
    expect(parsePronouns(42).ok).toBe(false);
    expect(parsePronouns(undefined).ok).toBe(false);
  });

  it("does not interpret markup: it is kept as typed, for the client to show as text", () => {
    expect(parsePronouns("<b>x</b>")).toEqual({ ok: true, value: "<b>x</b>" });
  });
});

describe("parseAccentColor", () => {
  it("accepts #rrggbb in either case and stores it in lower case", () => {
    expect(parseAccentColor("#FFAA00")).toEqual({ ok: true, value: "#ffaa00" });
    expect(parseAccentColor("#00ff7f")).toEqual({ ok: true, value: "#00ff7f" });
  });

  it("accepts null as none", () => {
    expect(parseAccentColor(null)).toEqual({ ok: true, value: null });
  });

  it("rejects anything else a stylesheet might read as a colour", () => {
    for (const bad of ["red", "#fff", "#12345", "#1234567", "rgb(0,0,0)", "#gggggg", "url(x)", "", 5, undefined]) {
      expect(parseAccentColor(bad).ok, String(bad)).toBe(false);
    }
  });
});

describe("sanitizeRemoteProfile", () => {
  const good = {
    displayName: "Carol",
    avatarUrl: "/uploads/carol.png",
    bio: "Line one\nLine two",
    pronouns: "she/her",
    accentColor: "#AA00FF",
  };

  it("passes good fields through, with the colour normalised", () => {
    expect(sanitizeRemoteProfile(good)).toEqual({ ...good, accentColor: "#aa00ff" });
  });

  it("treats fields an older peer does not send as empty, not as an error", () => {
    expect(sanitizeRemoteProfile({ displayName: "Carol", avatarUrl: null })).toEqual({
      displayName: "Carol",
      avatarUrl: null,
      bio: null,
      pronouns: null,
      accentColor: null,
    });
  });

  it("survives a peer returning something that is not an object at all", () => {
    for (const junk of [null, undefined, "x", 3, [], true]) {
      expect(sanitizeRemoteProfile(junk)).toEqual({
        displayName: undefined,
        avatarUrl: null,
        bio: null,
        pronouns: null,
        accentColor: null,
      });
    }
  });

  it("drops each invalid field on its own and keeps the valid ones", () => {
    const result = sanitizeRemoteProfile({ ...good, pronouns: "x".repeat(500), accentColor: "red", bio: 12 });

    expect(result.pronouns).toBeNull();
    expect(result.accentColor).toBeNull();
    expect(result.bio).toBeNull();
    expect(result.displayName).toBe("Carol");
    expect(result.avatarUrl).toBe("/uploads/carol.png");
  });

  it("drops a bio that is too long or has control characters, but keeps its line breaks and tabs", () => {
    expect(sanitizeRemoteProfile({ bio: "x".repeat(513) }).bio).toBeNull();
    expect(sanitizeRemoteProfile({ bio: "x".repeat(512) }).bio).toBe("x".repeat(512));
    expect(sanitizeRemoteProfile({ bio: "a\u0007b" }).bio).toBeNull();
    expect(sanitizeRemoteProfile({ bio: "a\r\n\tb" }).bio).toBe("a\r\n\tb");
    expect(sanitizeRemoteProfile({ bio: "   \n " }).bio).toBeNull();
  });

  it("keeps the cached name (returns undefined) when the peer's name is empty, too long or has control characters", () => {
    expect(sanitizeRemoteProfile({ displayName: "  " }).displayName).toBeUndefined();
    expect(sanitizeRemoteProfile({ displayName: "x".repeat(65) }).displayName).toBeUndefined();
    expect(sanitizeRemoteProfile({ displayName: "a\nb" }).displayName).toBeUndefined();
    expect(sanitizeRemoteProfile({ displayName: 7 }).displayName).toBeUndefined();
  });

  it("accepts only a stored upload path or an absolute http(s) address as a picture", () => {
    expect(sanitizeRemoteProfile({ avatarUrl: "https://cdn.example/a.png" }).avatarUrl).toBe("https://cdn.example/a.png");
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAAA", "//evil.example/a.png", "../etc/passwd", "uploads/a.png"]) {
      expect(sanitizeRemoteProfile({ avatarUrl: bad }).avatarUrl, bad).toBeNull();
    }
  });
});
