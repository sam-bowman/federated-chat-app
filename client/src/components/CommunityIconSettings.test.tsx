import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import { resetHomeServerStateForTests } from "../api/client";
import CommunityIconSettings from "./CommunityIconSettings";

const uploadFile = vi.fn();
const updateCommunity = vi.fn();
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  updateCommunity: (...args: unknown[]) => updateCommunity(...args),
}));

const refreshCommunities = vi.fn();
vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ refreshCommunities }) }));

// mediaUrl() needs a home server to resolve an uploaded picture's path against.
beforeEach(() => {
  import.meta.env.VITE_API_URL = "http://localhost:4000";
  resetHomeServerStateForTests();
  refreshCommunities.mockResolvedValue(undefined);
  updateCommunity.mockResolvedValue({});
  uploadFile.mockResolvedValue({ url: "/uploads/new.png" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetHomeServerStateForTests();
});

function community(extra: Partial<Community> = {}): Community {
  return {
    id: "C1",
    name: "Book Club",
    description: null,
    iconUrl: null,
    iconText: null,
    iconColor: null,
    homeserverDomain: "chat.example",
    ...extra,
  } as Community;
}

function open(extra: Partial<Community> = {}) {
  render(<CommunityIconSettings community={community(extra)} />);
}

const letters = () => screen.getByLabelText("Letters") as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save icon" }) as HTMLButtonElement;
const previews = () => [...document.querySelectorAll(".tile-preview .rail-item")] as HTMLElement[];
const nativeInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const picture = (type = "image/png") => new File(["x"], "icon.png", { type });

describe("the previews", () => {
  it("show the tile as the rail draws it, normal and selected, with the default letters", () => {
    open();

    const [normal, selected] = previews();
    expect(normal.textContent).toBe("BO");
    expect(selected.textContent).toBe("BO");
    expect(normal.className).not.toContain("active");
    expect(selected.className).toContain("active");
  });

  it("follow what is being typed, before it is saved", () => {
    open();

    fireEvent.change(letters(), { target: { value: "bk" } });

    expect(previews().map((p) => p.textContent)).toEqual(["bk", "bk"]);
    expect(updateCommunity).not.toHaveBeenCalled();
  });

  it("show the saved letters and colour, with a readable text colour", () => {
    open({ iconText: "XY", iconColor: "#e8b84b" });

    const [normal] = previews();
    expect(normal.textContent).toBe("XY");
    expect(normal.style.getPropertyValue("--tile-bg")).toBe("#e8b84b");
    expect(normal.style.getPropertyValue("--tile-fg")).toBe("#000000");
  });

  it("show the picture instead of the letters when there is one", () => {
    open({ iconUrl: "/uploads/icon.png" });

    expect(previews().every((p) => p.querySelector("img") !== null)).toBe(true);
    expect(previews()[0].textContent).toBe("");
  });
});

describe("the letters", () => {
  it("start from the saved ones, with the default as the hint when there are none", () => {
    open({ iconText: "ZZ" });
    expect(letters().value).toBe("ZZ");
    cleanup();

    open();
    expect(letters().value).toBe("");
    expect(letters().placeholder).toBe("BO");
  });

  it("cannot be saved until something changes", () => {
    open({ iconText: "ZZ" });

    expect(save().disabled).toBe(true);

    fireEvent.change(letters(), { target: { value: "ZY" } });
    expect(save().disabled).toBe(false);

    fireEvent.change(letters(), { target: { value: "ZZ" } });
    expect(save().disabled).toBe(true);
  });

  it("refuse more than three characters, say so, and keep the saved ones in the preview", () => {
    open({ iconText: "ZZ" });

    fireEvent.change(letters(), { target: { value: "ABCD" } });

    expect(letters().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Use 1 to 3 characters.")).toBeTruthy();
    expect(save().disabled).toBe(true);
    expect(previews()[0].textContent).toBe("ZZ");
  });

  it("count a skin-toned emoji or a flag as one character", () => {
    open();

    fireEvent.change(letters(), { target: { value: "👍🏽🇬🇧A" } });

    expect(letters().getAttribute("aria-invalid")).toBe("false");
    expect(save().disabled).toBe(false);
  });

  it("are sent trimmed, and saving keeps the colour as it was", async () => {
    open({ iconColor: "#3bc47e" });

    fireEvent.change(letters(), { target: { value: "  bc " } });
    fireEvent.click(save());

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { iconText: "bc", iconColor: "#3bc47e" }));
    expect(refreshCommunities).toHaveBeenCalled();
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("go back to the default when emptied, which is sent as null", async () => {
    open({ iconText: "ZZ" });

    fireEvent.change(letters(), { target: { value: "" } });
    fireEvent.click(save());

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { iconText: null, iconColor: null }));
  });

  it("say when saving failed, and stay editable", async () => {
    updateCommunity.mockRejectedValue(new Error("boom"));
    open();

    fireEvent.change(letters(), { target: { value: "ab" } });
    fireEvent.click(save());

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save the icon.");
    expect(save().disabled).toBe(false);
  });
});

describe("the colour", () => {
  const swatch = (name: string) => screen.getByRole("button", { name });

  it("is the default colour until one is chosen, and 'Default colour' is the way back", async () => {
    open({ iconColor: "#3bc47e" });

    fireEvent.click(swatch("Tile colour: #3bc47e. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "Default colour" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(save());

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { iconText: null, iconColor: null }));
    expect(previews()[0].className).not.toContain("rail-tile-coloured");
  });

  it("is chosen in the colour picker, shown in the previews at once, and saved with Save icon", async () => {
    open();
    expect(swatch("Tile colour: default colour. Change")).toBeTruthy();

    fireEvent.click(swatch("Tile colour: default colour. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "Purple (#a66cf0)" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(previews()[0].style.getPropertyValue("--tile-bg")).toBe("#a66cf0");
    expect(updateCommunity).not.toHaveBeenCalled(); // not until Save icon
    fireEvent.click(save());
    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { iconText: null, iconColor: "#a66cf0" }));
  });

  it("leaves things alone when the picker is cancelled", () => {
    open();

    fireEvent.click(swatch("Tile colour: default colour. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "Purple (#a66cf0)" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a colour" })).getByRole("button", { name: "Cancel" }));

    expect(previews()[0].className).not.toContain("rail-tile-coloured");
    expect(save().disabled).toBe(true);
  });
});

describe("the picture", () => {
  it("is uploaded and applied as soon as it is chosen", async () => {
    open();

    fireEvent.change(nativeInput(), { target: { files: [picture()] } });

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { iconUrl: "/uploads/new.png" }));
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(refreshCommunities).toHaveBeenCalled();
  });

  it("offers to change it, and to remove it, only when there is one", () => {
    open();
    expect(screen.getByRole("button", { name: "Upload a picture" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove picture" })).toBeNull();
    cleanup();

    open({ iconUrl: "/uploads/icon.png" });
    expect(screen.getByRole("button", { name: "Change picture" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove picture" })).toBeTruthy();
  });

  it("is removed with null, going back to the letters", async () => {
    open({ iconUrl: "/uploads/icon.png" });

    fireEvent.click(screen.getByRole("button", { name: "Remove picture" }));

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { iconUrl: null }));
    expect(refreshCommunities).toHaveBeenCalled();
  });

  // The upload route also takes documents and video; only a picture is a tile.
  it.each(["application/pdf", "video/mp4", "text/plain", ""])("refuses a file of type %j, uploading nothing", (type) => {
    open();

    fireEvent.change(nativeInput(), { target: { files: [picture(type)] } });

    expect(screen.getByRole("alert").textContent).toContain("isn't a picture");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(updateCommunity).not.toHaveBeenCalled();
  });

  it("says so when the upload fails, and changes nothing", async () => {
    uploadFile.mockRejectedValue(new Error("too large"));
    open({ iconUrl: "/uploads/icon.png" });

    fireEvent.change(nativeInput(), { target: { files: [picture()] } });

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't use that picture");
    expect(updateCommunity).not.toHaveBeenCalled();
  });

  it("says so when removing fails", async () => {
    updateCommunity.mockRejectedValue(new Error("boom"));
    open({ iconUrl: "/uploads/icon.png" });

    fireEvent.click(screen.getByRole("button", { name: "Remove picture" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't remove the picture.");
  });

  it("explains that the picture is shown instead of the letters", () => {
    open({ iconUrl: "/uploads/icon.png" });

    expect(screen.getByText(/shown instead of the letters/)).toBeTruthy();
  });

  it("is blocked from a second action while one is running", async () => {
    let finish: (v: unknown) => void = () => {};
    updateCommunity.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    open({ iconUrl: "/uploads/icon.png" });

    fireEvent.click(screen.getByRole("button", { name: "Remove picture" }));

    await waitFor(() => expect((screen.getByRole("button", { name: "Change picture" }) as HTMLButtonElement).disabled).toBe(true));
    expect(save().disabled).toBe(true);
    finish({});
  });
});
