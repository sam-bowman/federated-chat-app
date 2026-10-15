import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOnAnotherServer, isRemoteIdentity, resetFederationState, setFederationEnabled, useFederationEnabled } from "./federation";

const getHomeServer = vi.fn();
vi.mock("../api/client", () => ({ getHomeServer: () => getHomeServer() }));
const fetchServerInfo = vi.fn();
vi.mock("../api/discovery", () => ({ fetchServerInfo: (...args: unknown[]) => fetchServerInfo(...args) }));

function Probe() {
  return <div data-testid="state">{useFederationEnabled() ? "on" : "off"}</div>;
}
const state = () => screen.getByTestId("state").textContent;
const settle = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  resetFederationState();
  getHomeServer.mockReturnValue({ origin: "https://chat.example" });
  fetchServerInfo.mockResolvedValue({ serverName: "x", domain: "chat.example", federationEnabled: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("isRemoteIdentity", () => {
  it("is false for someone on this server, however it is written", () => {
    for (const text of ["alex", "@alex", "alex:chat.example", "@alex:chat.example", "@alex:CHAT.example", "  @alex:chat.example  "]) {
      expect(isRemoteIdentity(text, "chat.example"), text).toBe(false);
    }
  });

  it("is true for someone on another server", () => {
    for (const text of ["@alex:far.example", "alex:far.example", "@alex:far.example:8443", "@alex:chat.example.evil.example"]) {
      expect(isRemoteIdentity(text, "chat.example"), text).toBe(true);
    }
  });

  it("is false for what is not an identity at all, which the server will say something about", () => {
    for (const text of ["", "   ", "a b", ":", "@:far.example", "alex:"]) expect(isRemoteIdentity(text, "chat.example"), JSON.stringify(text)).toBe(false);
  });

  it("compares the whole domain, port included", () => {
    expect(isRemoteIdentity("@alex:localhost:4001", "localhost:4000")).toBe(true);
    expect(isRemoteIdentity("@alex:localhost:4000", "localhost:4000")).toBe(false);
  });
});

describe("isOnAnotherServer", () => {
  it("compares the servers of two identities", () => {
    expect(isOnAnotherServer("@a:far.example", "@me:chat.example")).toBe(true);
    expect(isOnAnotherServer("@a:chat.example", "@me:chat.example")).toBe(false);
    expect(isOnAnotherServer("@a:CHAT.example", "@me:chat.example")).toBe(false);
  });
});

describe("useFederationEnabled", () => {
  it("is on until the server says otherwise", () => {
    getHomeServer.mockReturnValue(null);
    render(<Probe />);

    expect(state()).toBe("on");
  });

  it("asks the home server's discovery document, and turns off when it says it is private", async () => {
    fetchServerInfo.mockResolvedValue({ serverName: "x", domain: "chat.example", federationEnabled: false });
    render(<Probe />);
    await settle();

    expect(fetchServerInfo).toHaveBeenCalledWith("https://chat.example");
    expect(state()).toBe("off");
  });

  it("stays on when the server says nothing about it, as older servers do", async () => {
    fetchServerInfo.mockResolvedValue({ serverName: "x", domain: "chat.example" });
    render(<Probe />);
    await settle();

    expect(state()).toBe("on");
  });

  it("does not claim a server is private because it could not be asked", async () => {
    fetchServerInfo.mockRejectedValue(new TypeError("offline"));
    render(<Probe />);
    await settle();

    expect(state()).toBe("on");
  });

  it("asks once for a server, however many places use it", async () => {
    render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>
    );
    await settle();

    expect(fetchServerInfo).toHaveBeenCalledTimes(1);
  });

  it("asks again when the window regains focus after a minute, so a restarted server is noticed, but not before", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    render(<Probe />);
    await settle();
    expect(fetchServerInfo).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-15T12:00:30Z"));
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(fetchServerInfo).toHaveBeenCalledTimes(1);

    fetchServerInfo.mockResolvedValue({ serverName: "x", domain: "chat.example", federationEnabled: false });
    vi.setSystemTime(new Date("2026-10-15T12:01:30Z"));
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(fetchServerInfo).toHaveBeenCalledTimes(2);
    expect(state()).toBe("off");
  });

  it("stops listening for focus when nothing uses it any more", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    render(<Probe />);
    await settle();
    cleanup();

    vi.setSystemTime(new Date("2026-10-15T12:05:00Z"));
    window.dispatchEvent(new Event("focus"));
    await settle();

    expect(fetchServerInfo).toHaveBeenCalledTimes(1);
  });

  it("turns back on when the server does", async () => {
    render(<Probe />);
    await settle();

    act(() => setFederationEnabled(false));
    expect(state()).toBe("off");
    act(() => setFederationEnabled(true));
    expect(state()).toBe("on");
  });
});
