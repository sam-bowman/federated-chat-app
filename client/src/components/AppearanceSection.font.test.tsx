import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FONT_STACK, FONT_CHOICES, FONT_LABELS, SYSTEM_MONO_STACK, startAppearance } from "../lib/appearance";
import AppearanceSection from "./AppearanceSection";

const PROPERTIES = ["--ui-scale", "--ui-font", "--font-ligatures", "--message-font", "--message-ligatures"];
const prop = (name: string) => document.documentElement.style.getPropertyValue(name);
const stored = () => JSON.parse(localStorage.getItem("chat.appearance") ?? "null");

beforeEach(() => {
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
