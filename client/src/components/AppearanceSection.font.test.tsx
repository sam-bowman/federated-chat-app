import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FONT_STACK, FONT_CHOICES, FONT_LABELS, SYSTEM_MONO_STACK, startAppearance } from "../lib/appearance";
// jsdom has no canvas, so what the browser would say about a font's ligatures is set by each test (null: it cannot tell).
const probe = vi.hoisted(() => vi.fn<(stack: string) => boolean | null>(() => null));
vi.mock("../lib/fontLigatures", () => ({ drawsLigatures: probe }));

import AppearanceSection, { FONT_LICENCES_PATH, FONT_LICENCES_URL } from "./AppearanceSection";

const PROPERTIES = ["--ui-scale", "--ui-font", "--font-ligatures", "--message-font", "--message-ligatures"];
const prop = (name: string) => document.documentElement.style.getPropertyValue(name);
const stored = () => JSON.parse(localStorage.getItem("chat.appearance") ?? "null");

beforeEach(() => {
  probe.mockReset().mockReturnValue(null);
  localStorage.clear();
  for (const name of PROPERTIES) document.documentElement.style.removeProperty(name);
  startAppearance();
});
afterEach(cleanup);

const select = () => screen.getByLabelText("Font") as HTMLSelectElement;
const choose = (value: string) => fireEvent.change(select(), { target: { value } });
const messagesOnly = () => screen.queryByLabelText("Use this font for messages only") as HTMLInputElement | null;
const ligatures = () => screen.queryByLabelText(/^Ligatures/) as HTMLInputElement | null;
const preview = () => document.querySelector(".font-preview") as HTMLElement;
const nameBox = () => screen.queryByLabelText("Name of the font") as HTMLInputElement | null;

describe("Settings -> Appearance -> Font", () => {
  it("offers every font, in words, starting on the default", () => {
    render(<AppearanceSection />);

    expect([...select().options].map((o) => o.textContent)).toEqual(FONT_CHOICES.map((f) => FONT_LABELS[f]));
    expect(select().value).toBe("default");
  });

  it("changes nothing, and offers no extra choices, for the default font", () => {
    render(<AppearanceSection />);

    expect(messagesOnly()).toBeNull();
    expect(ligatures()).toBeNull();
    expect(prop("--ui-font")).toBe("");
    expect(preview().style.fontFamily).toContain("Segoe UI");
  });

  it("applies a bundled font to the whole UI at once, shows it in the sample line, and remembers it", () => {
    render(<AppearanceSection />);

    choose("jetbrains-mono");

    expect(prop("--ui-font")).toBe(`"JetBrains Mono", ${SYSTEM_MONO_STACK}`);
    expect(preview().style.fontFamily).toContain("JetBrains Mono");
    expect(stored()).toMatchObject({ font: "jetbrains-mono", fontScope: "ui" });
  });

  it("offers the ligatures choice only for fonts that have ligatures", () => {
    render(<AppearanceSection />);

    choose("ibm-plex-mono");
    expect(ligatures()).toBeNull();

    choose("fira-code");
    expect(ligatures()).not.toBeNull();
  });

  it("draws no ligatures until they are turned on", () => {
    render(<AppearanceSection />);
    choose("fira-code");
    expect(prop("--font-ligatures")).toBe("none");
    expect(preview().style.fontVariantLigatures).toBe("none");

    fireEvent.click(ligatures()!);

    expect(prop("--font-ligatures")).toBe("");
    expect(preview().style.fontVariantLigatures).toBe("normal");
    expect(stored()).toMatchObject({ ligatures: true });
  });

  it("moves the font to messages only, leaving the rest of the UI in the usual font", () => {
    render(<AppearanceSection />);
    choose("fira-code");

    fireEvent.click(messagesOnly()!);

    expect(prop("--message-font")).toContain("Fira Code");
    expect(prop("--ui-font")).toBe("");
    expect(stored()).toMatchObject({ fontScope: "messages" });

    fireEvent.click(messagesOnly()!);
    expect(prop("--ui-font")).toContain("Fira Code");
    expect(prop("--message-font")).toBe("");
  });

  it("goes back to the usual font and removes the extra choices", () => {
    render(<AppearanceSection />);
    choose("fira-code");

    choose("default");

    expect(prop("--ui-font")).toBe("");
    expect(messagesOnly()).toBeNull();
  });

  it("applies the system monospaces without naming any bundled file", () => {
    render(<AppearanceSection />);

    choose("mono-system");

    expect(prop("--ui-font")).toBe(SYSTEM_MONO_STACK);
  });

  it("links to the licences of the bundled fonts, which are served with the app", () => {
    render(<AppearanceSection />);

    const link = screen.getByRole("link", { name: "Font licences" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/THIRD-PARTY-FONTS.txt");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  describe("a font installed on this device", () => {
    it("asks for its name, and applies it with the usual stack behind it once the name is typed", () => {
      render(<AppearanceSection />);
      choose("custom");
      expect(prop("--ui-font")).toBe(""); // nothing to apply yet

      fireEvent.change(nameBox()!, { target: { value: "Comic Sans MS" } });

      expect(prop("--ui-font")).toBe(`"Comic Sans MS", ${DEFAULT_FONT_STACK}`);
      expect(stored()).toMatchObject({ font: "custom", customFont: "Comic Sans MS" });
    });

    it("explains a name it will not use, and does not apply it", () => {
      render(<AppearanceSection />);
      choose("custom");

      fireEvent.change(nameBox()!, { target: { value: 'Evil"; } body { display:none' } });

      expect(screen.getByRole("alert").textContent).toContain("letters, numbers, spaces");
      expect(prop("--ui-font")).toBe("");
      expect(nameBox()!.getAttribute("aria-invalid")).toBe("true");
    });

    it("stops using the font when the name is cleared, without an error", () => {
      render(<AppearanceSection />);
      choose("custom");
      fireEvent.change(nameBox()!, { target: { value: "Comic Sans MS" } });

      fireEvent.change(nameBox()!, { target: { value: "" } });

      expect(prop("--ui-font")).toBe("");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps the typed name when switching away from Custom and back", () => {
      render(<AppearanceSection />);
      choose("custom");
      fireEvent.change(nameBox()!, { target: { value: "Comic Sans MS" } });
      choose("fira-code");
      expect(nameBox()).toBeNull();

      choose("custom");

      expect(nameBox()!.value).toBe("Comic Sans MS");
      expect(prop("--ui-font")).toContain("Comic Sans MS");
    });

    it("limits the name to what the page accepts", () => {
      render(<AppearanceSection />);
      choose("custom");

      expect(nameBox()!.maxLength).toBe(64);
    });
  });
});

describe("the font licences link", () => {
  const link = () => screen.getByRole("link", { name: "Font licences" }) as HTMLAnchorElement;
  const win = window as unknown as { __TAURI_INTERNALS__?: unknown };
  afterEach(() => {
    delete win.__TAURI_INTERNALS__;
  });

  it("is the file next to the page in a browser, opening in a new tab", () => {
    render(<AppearanceSection />);
    expect(link().getAttribute("href")).toBe(FONT_LICENCES_PATH);
    expect(link().target).toBe("_blank");
  });

  it("is the same file in the project's repository in the desktop app, where a link opens in the person's own browser and cannot reach the app", () => {
    win.__TAURI_INTERNALS__ = {};
    render(<AppearanceSection />);
    expect(link().getAttribute("href")).toBe(FONT_LICENCES_URL);
    expect(FONT_LICENCES_URL).toMatch(/^https:\/\/github\.com\/.+\/client\/public\/THIRD-PARTY-FONTS\.txt$/);
    expect(link().target).toBe("_blank");
  });
});

describe("the Ligatures option is only offered where it can do something (#208)", () => {
  const note = () => screen.queryByText("This font does not draw ligatures, so there is nothing to turn on.");

  it("is offered for the bundled coding fonts without asking the browser, since they are known to have them", () => {
    render(<AppearanceSection />);
    for (const font of ["jetbrains-mono", "fira-code"]) {
      choose(font);
      expect(ligatures(), font).not.toBeNull();
      expect(note(), font).toBeNull();
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("is not offered for IBM Plex Mono, which has none, and says so", () => {
    render(<AppearanceSection />);
    choose("ibm-plex-mono");
    expect(ligatures()).toBeNull();
    expect(note()).not.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("is not offered for a system monospace the browser says has none (Cascadia Mono, Consolas...), and says so", () => {
    probe.mockReturnValue(false);
    render(<AppearanceSection />);
    choose("mono-system");

    expect(probe).toHaveBeenCalledWith(SYSTEM_MONO_STACK);
    expect(ligatures()).toBeNull();
    expect(note()).not.toBeNull();
  });

  it("is offered for a system monospace the browser says does draw them (Cascadia Code)", () => {
    probe.mockReturnValue(true);
    render(<AppearanceSection />);
    choose("mono-system");
    expect(ligatures()).not.toBeNull();
    expect(note()).toBeNull();
  });

  it("is offered when the browser cannot tell, rather than taking the option away on a guess", () => {
    probe.mockReturnValue(null);
    render(<AppearanceSection />);
    choose("mono-system");
    expect(ligatures()).not.toBeNull();
    expect(note()).toBeNull();
  });

  it("asks about the name typed for a custom font, and follows the answer as it changes", () => {
    render(<AppearanceSection />);
    choose("custom");
    probe.mockReturnValue(false);
    fireEvent.change(nameBox()!, { target: { value: "Comic Sans MS" } });
    expect(probe).toHaveBeenLastCalledWith(expect.stringContaining('"Comic Sans MS"'));
    expect(ligatures()).toBeNull();
    expect(note()).not.toBeNull();

    probe.mockReturnValue(true);
    fireEvent.change(nameBox()!, { target: { value: "Cascadia Code" } });
    expect(probe).toHaveBeenLastCalledWith(expect.stringContaining('"Cascadia Code"'));
    expect(ligatures()).not.toBeNull();
    expect(note()).toBeNull();
  });

  it("offers and says nothing for the default font", () => {
    render(<AppearanceSection />);
    expect(ligatures()).toBeNull();
    expect(note()).toBeNull();
  });
});
