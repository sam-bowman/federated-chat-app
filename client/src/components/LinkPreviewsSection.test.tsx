import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LinkPreviewsSection from "./LinkPreviewsSection";

const mocks = vi.hoisted(() => ({ fetchServerInfo: vi.fn(), getHomeServer: vi.fn() }));
vi.mock("../api/discovery", () => ({ fetchServerInfo: mocks.fetchServerInfo }));
vi.mock("../api/client", () => ({ getHomeServer: mocks.getHomeServer }));

beforeEach(() => {
  mocks.getHomeServer.mockReturnValue({ origin: "https://chat.example" });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("Settings -> Link previews", () => {
  it("is not offered on a server that does not make previews", async () => {
    mocks.fetchServerInfo.mockResolvedValue({ linkPreviewsEnabled: false });
    const { container } = render(<LinkPreviewsSection />);
    await waitFor(() => expect(mocks.fetchServerInfo).toHaveBeenCalledWith("https://chat.example"));
    expect(container.firstChild).toBeNull();
  });

  it("is not offered when the server cannot be asked", async () => {
    mocks.fetchServerInfo.mockRejectedValue(new Error("down"));
    const { container } = render(<LinkPreviewsSection />);
    await waitFor(() => expect(mocks.fetchServerInfo).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("lets the person hide and show previews on this device", async () => {
    mocks.fetchServerInfo.mockResolvedValue({ linkPreviewsEnabled: true });
    render(<LinkPreviewsSection />);

    const box = (await screen.findByRole("checkbox", { name: /show link previews/i })) as HTMLInputElement;
    expect(box.checked).toBe(true);

    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(localStorage.getItem("chat.linkPreviews")).toBe("hide");

    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(localStorage.getItem("chat.linkPreviews")).toBeNull();
  });

  it("offers the choice about pictures only where the server keeps them, and says where the picture comes from", async () => {
    mocks.fetchServerInfo.mockResolvedValue({ linkPreviewsEnabled: true, linkPreviewImagesEnabled: false });
    const without = render(<LinkPreviewsSection />);
    await screen.findByRole("checkbox", { name: /show link previews/i });
    expect(screen.queryByRole("checkbox", { name: /pictures/i })).toBeNull();
    expect(without.container.textContent).not.toContain("copy of the page");
    cleanup();

    mocks.fetchServerInfo.mockResolvedValue({ linkPreviewsEnabled: true, linkPreviewImagesEnabled: true });
    const withPictures = render(<LinkPreviewsSection />);
    expect(await screen.findByRole("checkbox", { name: /pictures/i })).toBeTruthy();
    expect(withPictures.container.textContent).toContain("never from the linked site");
  });

  it("lets the person turn pictures off on this device, separately, and not while previews are hidden altogether", async () => {
    mocks.fetchServerInfo.mockResolvedValue({ linkPreviewsEnabled: true, linkPreviewImagesEnabled: true });
    render(<LinkPreviewsSection />);
    const pictures = (await screen.findByRole("checkbox", { name: /pictures/i })) as HTMLInputElement;
    expect(pictures.checked).toBe(true);

    fireEvent.click(pictures);
    expect(pictures.checked).toBe(false);
    expect(localStorage.getItem("chat.linkPreviewPictures")).toBe("hide");
    expect(localStorage.getItem("chat.linkPreviews")).toBeNull(); // previews themselves are still shown

    fireEvent.click(pictures);
    expect(localStorage.getItem("chat.linkPreviewPictures")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /show link previews/i }));
    expect(pictures.disabled).toBe(true);
  });
});
