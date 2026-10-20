import { afterEach, describe, expect, it, vi } from "vitest";
import { drawsLigatures } from "./fontLigatures";

// jsdom has no canvas, so a fake one records what is drawn and answers with a picture that depends on the rendering mode.
type Rendering = "optimizeLegibility" | "optimizeSpeed";

function fakeCanvas(options: { ligaturesChangeThePicture: boolean; hasTextRendering?: boolean; throws?: boolean }) {
  const drawn: { font: string; rendering: string; text: string }[] = [];
  let rendering: string = "auto";
  let font = "";
  let lastRendering: Rendering = "optimizeLegibility";
  const context: Record<string, unknown> = {
    clearRect: () => undefined,
    fillText: (text: string) => {
      drawn.push({ font, rendering, text });
      lastRendering = rendering as Rendering;
    },
    getImageData: () => {
      if (options.throws) throw new Error("tainted");
      // Two pixels: one that is always drawn, one that only differs when ligatures are on.
      const second = options.ligaturesChangeThePicture && lastRendering === "optimizeLegibility" ? 255 : 0;
      return { data: new Uint8ClampedArray([10, second]) };
    },
    set font(value: string) {
      font = value;
    },
    get font() {
      return font;
    },
  };
  if (options.hasTextRendering !== false) {
    Object.defineProperty(context, "textRendering", { get: () => rendering, set: (v: string) => (rendering = v), enumerable: true });
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as never);
  return drawn;
}

afterEach(() => vi.restoreAllMocks());

describe("drawsLigatures", () => {
  it("says yes when allowing ligatures changes the picture", () => {
    fakeCanvas({ ligaturesChangeThePicture: true });
    expect(drawsLigatures('"Fira Code", monospace')).toBe(true);
  });

  it("says no when the picture is the same with ligatures allowed or not", () => {
    fakeCanvas({ ligaturesChangeThePicture: false });
    expect(drawsLigatures('"Cascadia Mono", Consolas, monospace')).toBe(false);
  });

  it("draws the same symbols twice in the font it was asked about, once with ligatures allowed and once without", () => {
    const drawn = fakeCanvas({ ligaturesChangeThePicture: true });
    drawsLigatures('"My Font", monospace');

    expect(drawn).toHaveLength(2);
    expect(drawn[0].text).toBe(drawn[1].text);
    expect(drawn[0].text).toContain("->");
    expect(drawn[0].text).toContain("!=");
    expect(drawn.map((d) => d.rendering)).toEqual(["optimizeLegibility", "optimizeSpeed"]);
    for (const d of drawn) expect(d.font).toBe('24px "My Font", monospace');
  });

  it("says it cannot tell, rather than no, when the browser has no way to switch ligatures off on a canvas", () => {
    fakeCanvas({ ligaturesChangeThePicture: true, hasTextRendering: false });
    expect(drawsLigatures("monospace")).toBeNull();
  });

  it("says it cannot tell when there is no canvas at all", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as never);
    expect(drawsLigatures("monospace")).toBeNull();
  });

  it("says it cannot tell when reading the picture fails", () => {
    fakeCanvas({ ligaturesChangeThePicture: true, throws: true });
    expect(drawsLigatures("monospace")).toBeNull();
  });
});
