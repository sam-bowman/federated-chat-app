import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AboutSection from "./AboutSection";

const mockClient = vi.hoisted(() => ({ getHomeServer: vi.fn() }));
vi.mock("../api/client", () => mockClient);

const mockDiscovery = vi.hoisted(() => ({ fetchServerInfo: vi.fn() }));
vi.mock("../api/discovery", () => mockDiscovery);

beforeEach(() => {
  mockClient.getHomeServer.mockReturnValue({
    origin: "https://chat.example.com",
    domain: "chat.example.com",
    serverName: "Example Chat",
    registrationEnabled: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AboutSection", () => {
  it("shows the client build and, once fetched, the home server's name, version and protocol", async () => {
    mockDiscovery.fetchServerInfo.mockResolvedValue({
      serverName: "Example Chat",
      domain: "chat.example.com",
      serverVersion: "0.11.0",
      protocolVersion: "0.1.0",
    });
    render(<AboutSection />);

    expect(screen.getByText("Client")).not.toBeNull();
    // Vitest does not apply vite.config.ts's define, so this is the development-build fallback.
    expect(screen.getByText("development build")).not.toBeNull();
    expect(screen.getByText("Checking…")).not.toBeNull();

    await waitFor(() => expect(screen.getByText(/v0\.11\.0/)).not.toBeNull());
    expect(mockDiscovery.fetchServerInfo.mock.calls[0][0]).toBe("https://chat.example.com");
    const server = screen.getByText(/Example Chat/).parentElement!;
    expect(server.textContent).toContain("chat.example.com");
    expect(server.textContent).toContain("federation protocol 0.1.0");
  });

  it("says so when an older server does not report a version", async () => {
    mockDiscovery.fetchServerInfo.mockResolvedValue({ serverName: "Old", domain: "old.example" });
    render(<AboutSection />);

    await waitFor(() => expect(screen.getByText(/version not reported/)).not.toBeNull());
  });

  it("shows a clear message when the server cannot be reached, without hiding the client version", async () => {
    mockDiscovery.fetchServerInfo.mockRejectedValue(new Error("offline"));
    render(<AboutSection />);

    await waitFor(() => expect(screen.getByText("Couldn't reach the server to check its version.")).not.toBeNull());
    expect(screen.getByText("development build")).not.toBeNull();
  });

  it("renders server-supplied text as text, never as markup", async () => {
    mockDiscovery.fetchServerInfo.mockResolvedValue({
      serverName: "<img src=x onerror=alert(1)>",
      domain: "evil.example",
      serverVersion: "<b>9</b>",
    });
    const { container } = render(<AboutSection />);

    await waitFor(() => expect(container.textContent).toContain("<img src=x onerror=alert(1)>"));
    expect(container.querySelector("img, b")).toBeNull();
  });
});
