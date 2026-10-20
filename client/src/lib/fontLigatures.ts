// Whether a font stack really draws ligatures, found by drawing the same text twice on a canvas, once with ligatures allowed
// ("optimizeLegibility") and once with them switched off ("optimizeSpeed", which also turns off kerning and ligatures),
// and comparing the pictures. A font with no ligatures draws the same both ways. It is how Settings -> Appearance knows
// not to offer a checkbox that could never change anything (#208: "Monospace (system)" picked Cascadia Mono, which has none).

// The pairs coding fonts draw as one symbol: arrows, comparisons, equality, a repeated letter.
const SAMPLE = "-> => != <= >= == === www";
const WIDTH = 320;
const HEIGHT = 48;

/**
 * True if `fontFamily` (a CSS font-family list) draws ligatures, false if it does not, and null when this browser cannot
 * tell (no canvas, or no `textRendering` on it): the caller then gives the font the benefit of the doubt.
 */
export function drawsLigatures(fontFamily: string): boolean | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !("textRendering" in context)) return null;

    const draw = (rendering: CanvasTextRendering): Uint8ClampedArray => {
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.font = `24px ${fontFamily}`;
      context.textRendering = rendering;
      context.fillText(SAMPLE, 4, 32);
      return context.getImageData(0, 0, WIDTH, HEIGHT).data;
    };
    const withLigatures = draw("optimizeLegibility");
    const without = draw("optimizeSpeed");
    for (let i = 0; i < withLigatures.length; i++) if (withLigatures[i] !== without[i]) return true;
    return false;
  } catch {
    return null;
  }
}
