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
});
