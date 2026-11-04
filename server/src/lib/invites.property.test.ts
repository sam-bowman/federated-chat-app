// Property tests (fast-check) for the community join reference and invite codes (#325). A reference is typed or pasted by a person, or arrives
// inside a card from another server, so it is a stranger's text; the parser must never throw, must only give back pieces of the shape it
// promises, and must undo what inviteJoinReference does for every id, domain and code that is allowed.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INVITE_CODE_LENGTH, INVITE_CODE_PATTERN, generateInviteCode, inviteJoinReference, normalizeInviteCode, parseJoinReference } from "./invites.js";

const AWKWARD = ["@", ":", "#", "%", "/", " ", "\n", "\t", "ABC123", "chat.example", "Chat.Example:8443", "0123456789ABCDEFGHJKMNPQRSTVWXYZ", "é", "😀", "‮", "\u0000"];
const reference = fc.array(fc.oneof(fc.constantFrom(...AWKWARD), fc.string({ maxLength: 5 })), { maxLength: 12 }).map((p) => p.join(""));

describe("parseJoinReference, for any text", () => {
  it("never throws, and gives back only a plain id, a lower-case domain with no space or #, and a code of the allowed shape", () => {
    fc.assert(
      fc.property(reference, fc.constantFrom("chat.example", "Local.Test"), (text, home) => {
        const parsed = parseJoinReference(text, home);
        if (parsed === null) return;
        expect(parsed.protocolId).toMatch(/^[0-9A-Za-z]+$/u);
        expect(parsed.domain).toBe(parsed.domain.toLowerCase());
        expect(parsed.domain).not.toMatch(/[#\s]/u);
        expect(parsed.domain).not.toBe("");
        if (parsed.code !== null) expect(parsed.code).toMatch(INVITE_CODE_PATTERN);
      }),
      { numRuns: 2000 }
    );
  });
});

describe("parseJoinReference and inviteJoinReference, for any id, domain and code that are allowed", () => {
  const id = fc.stringMatching(/^[0-9A-Za-z]{10,30}$/u);
  const domain = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,28}(:[0-9]{1,5})?$/u);
  const code = fc.stringMatching(/^[0-9A-Za-z]{6,32}$/u);

  it("undo each other, keeping the case of the id and the code and lower-casing the domain", () => {
    fc.assert(
      fc.property(id, domain, code, (protocolId, homeserverDomain, inviteCode) => {
        const written = inviteJoinReference({ protocolId, homeserverDomain }, inviteCode);
        expect(parseJoinReference(written, "elsewhere.example")).toEqual({ protocolId, domain: homeserverDomain.toLowerCase(), code: inviteCode });
      }),
      { numRuns: 1000 }
    );
  });

  it("gives the home domain when none is written, and no code when none is written", () => {
    fc.assert(
      fc.property(id, (protocolId) => {
        expect(parseJoinReference(protocolId, "Home.Example")).toEqual({ protocolId, domain: "home.example", code: null });
        expect(parseJoinReference(`  @${protocolId}  `, "home.example")).toEqual({ protocolId, domain: "home.example", code: null });
      }),
      { numRuns: 300 }
    );
  });

  it("refuses a code that is too short, too long or not alphanumeric", () => {
    fc.assert(
      fc.property(id, fc.oneof(fc.stringMatching(/^[0-9A-Za-z]{1,5}$/u), fc.stringMatching(/^[0-9A-Za-z]{33,40}$/u)), (protocolId, badCode) => {
        expect(parseJoinReference(`${protocolId}#${badCode}`, "home.example")).toBeNull();
      }),
      { numRuns: 300 }
    );
  });
});

describe("invite codes", () => {
  it("are made of the alphabet only, ten long, and already in the form they are stored in", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const code = generateInviteCode();
        expect(code).toHaveLength(INVITE_CODE_LENGTH);
        expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/u);
        expect(normalizeInviteCode(code)).toBe(code);
        expect(code).toMatch(INVITE_CODE_PATTERN);
      }),
      { numRuns: 500 }
    );
  });

  it("are found again by typing them in any case, with spaces around", () => {
    fc.assert(
      fc.property(fc.constant(null), fc.constantFrom("", " ", "  "), (_, space) => {
        const code = generateInviteCode();
        expect(normalizeInviteCode(`${space}${code.toLowerCase()}${space}`)).toBe(code);
      }),
      { numRuns: 300 }
    );
  });

  it("normalise to the same thing again", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        expect(normalizeInviteCode(normalizeInviteCode(text))).toBe(normalizeInviteCode(text));
      }),
      { numRuns: 500 }
    );
  });
});
