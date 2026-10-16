import { describe, expect, it } from "vitest";
import type { Emoticon } from "../api";
import { allEmoticons, hasEmoticons, NO_EMOTICONS, renderableSets, searchEmoticons } from "./emoticonSets";

function emoticon(id: string, trigger: string, name = id, communityId: string | null = null): Emoticon {
  return { id, name, trigger, imageUrl: `/uploads/${id}.png`, communityId } as Emoticon;
}

describe("renderableSets", () => {
  it("drops an emoticon whose trigger a later source replaces, as the server resolves it", () => {
    // The server adds personal, then saved, then community, and a later one replaces an earlier one.
    const personal = emoticon("p", ":party:");
    const saved = emoticon("s", ":party:");
    const community = emoticon("c", ":party:", "c", "C1");
    const other = emoticon("o", ":cat:");

    const sets = renderableSets({ personal: [personal, other], saved: [saved], community: [community] });
    expect(sets.personal).toEqual([other]);
    expect(sets.saved).toEqual([]);
    expect(sets.community).toEqual([community]);
  });

  it("keeps everything when no triggers clash", () => {
    const sets = { personal: [emoticon("a", ":a:")], saved: [emoticon("b", ":b:")], community: [emoticon("c", ":c:")] };
    expect(renderableSets(sets)).toEqual(sets);
  });

  it("reports what is there", () => {
    expect(hasEmoticons(NO_EMOTICONS)).toBe(false);
    expect(hasEmoticons({ ...NO_EMOTICONS, saved: [emoticon("b", ":b:")] })).toBe(true);
    expect(allEmoticons({ personal: [emoticon("a", ":a:")], saved: [emoticon("b", ":b:")], community: [] })).toHaveLength(2);
  });
});

describe("searchEmoticons", () => {
  const list = [emoticon("1", ":hot_party:", "Fire"), emoticon("2", ":party:", "Confetti"), emoticon("3", ":cat:", "Party cat")];

  it("ranks a trigger that starts with the query, then one that contains it, then a name match", () => {
    expect(searchEmoticons(list, "party").map((e) => e.id)).toEqual(["2", "1", "3"]);
  });

  it("accepts the colons, ignores case, and needs every word", () => {
    expect(searchEmoticons(list, ":PAR").map((e) => e.id)).toEqual(["2", "1", "3"]);
    expect(searchEmoticons(list, "party cat").map((e) => e.id)).toEqual(["3"]);
    expect(searchEmoticons(list, "nothing")).toEqual([]);
    expect(searchEmoticons(list, "  ")).toEqual([]);
  });
});
