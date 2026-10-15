import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
import PrivateServerNotice from "./PrivateServerNotice";

afterEach(() => {
  cleanup();
  resetFederationState();
});

describe("PrivateServerNotice", () => {
  it("says nothing on a server that federates, where the conversation or community works as ever", () => {
    render(<PrivateServerNotice show>Held until it connects again.</PrivateServerNotice>);

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says its piece on a private server, where what is shown lives on another server", () => {
    setFederationEnabled(false);
    render(<PrivateServerNotice show>Held until it connects again.</PrivateServerNotice>);

    expect(screen.getByRole("note").textContent).toBe("Held until it connects again.");
  });

  it("says nothing on a private server about something that lives on this one", () => {
    setFederationEnabled(false);
    render(<PrivateServerNotice show={false}>Held until it connects again.</PrivateServerNotice>);

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("appears and disappears as the server's setting is learned", () => {
    render(<PrivateServerNotice show>Held.</PrivateServerNotice>);
    expect(screen.queryByRole("note")).toBeNull();

    act(() => setFederationEnabled(false));
    expect(screen.getByRole("note")).toBeTruthy();
    act(() => setFederationEnabled(true));
    expect(screen.queryByRole("note")).toBeNull();
  });
});
