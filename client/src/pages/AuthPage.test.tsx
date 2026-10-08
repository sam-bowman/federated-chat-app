import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthPage from "./AuthPage";
import { DiscoveryError } from "../api/discovery";

const mockUseAuth = vi.fn();
vi.mock("../context/AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAuthPage(mode: "login" | "register" = "login") {
  return render(
    <MemoryRouter>
      <AuthPage mode={mode} />
    </MemoryRouter>
  );
}

describe("AuthPage - fixed-server mode", () => {
  // Regression test: the identity preview used to hardcode `@${username}:localhost`
  // regardless of the server's actual configured domain - always wrong on any
  // non-localhost deployment. It should now reflect the real discovered domain.
  it("shows the real discovered domain in the identity preview, not a hardcoded localhost", () => {
    mockUseAuth.mockReturnValue({
      isFixedServerMode: true,
      homeServer: {
        origin: "https://chat.example.com",
        domain: "chat.example.com",
        serverName: "Example",
        registrationEnabled: true,
      },
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    });

    const { container } = renderAuthPage("login");

    expect(container.textContent).toContain("chat.example.com");
    expect(container.textContent).not.toContain("localhost");
  });

  it("falls back to the origin's hostname when discovery hasn't resolved a domain yet", () => {
    mockUseAuth.mockReturnValue({
      isFixedServerMode: true,
      homeServer: { origin: "http://localhost:4000", domain: "", serverName: "", registrationEnabled: true },
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    });

    const { container } = renderAuthPage("login");

    expect(container.textContent).toContain("localhost");
  });

  it("renders the login form directly with no server-entry step", () => {
    mockUseAuth.mockReturnValue({
      isFixedServerMode: true,
      homeServer: { origin: "http://localhost:4000", domain: "localhost", serverName: "Local", registrationEnabled: true },
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    });

    renderAuthPage("login");

    expect(screen.queryByPlaceholderText("username")).not.toBeNull();
    expect(screen.queryByText("Find your server")).toBeNull();
  });
});

describe("AuthPage - picker mode", () => {
  it("shows the server-entry step first when no home server is resolved yet", () => {
    mockUseAuth.mockReturnValue({
      isFixedServerMode: false,
      homeServer: null,
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    });

    renderAuthPage("login");

    expect(screen.queryByText("Find your server")).not.toBeNull();
    expect(screen.queryByPlaceholderText("username")).toBeNull();
  });

  it("reveals the login form with a prefilled username after successfully resolving a server", async () => {
    const resolvedServer = {
      origin: "https://chat.example.com",
      domain: "chat.example.com",
      serverName: "Example",
      registrationEnabled: true,
    };
    const resolveHomeServer = vi.fn().mockResolvedValue(resolvedServer);
    const authState: any = {
      isFixedServerMode: false,
      homeServer: null,
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer,
      switchServer: vi.fn(),
    };
    mockUseAuth.mockImplementation(() => authState);

    const { rerender } = renderAuthPage("login");

    fireEvent.change(screen.getByPlaceholderText("@you:chat.example.com"), {
      target: { value: "@alice:chat.example.com" },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => expect(resolveHomeServer).toHaveBeenCalledWith("@alice:chat.example.com"));

    // Simulate the context re-rendering with the now-resolved home server.
    authState.homeServer = resolvedServer;
    rerender(
      <MemoryRouter>
        <AuthPage mode="login" />
      </MemoryRouter>
    );

    const usernameInput = screen.getByPlaceholderText("username") as HTMLInputElement;
    expect(usernameInput.value).toBe("alice");
  });

  it("shows a clear error and stays on the entry step when the server can't be reached", async () => {
    const resolveHomeServer = vi
      .fn()
      .mockRejectedValue(new DiscoveryError("network_error", "Couldn't reach that server."));
    mockUseAuth.mockReturnValue({
      isFixedServerMode: false,
      homeServer: null,
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer,
      switchServer: vi.fn(),
    });

    renderAuthPage("login");
    fireEvent.change(screen.getByPlaceholderText("@you:chat.example.com"), { target: { value: "unreachable.example" } });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => expect(screen.queryByText("Couldn't reach that server.")).not.toBeNull());
    expect(screen.queryByText("Find your server")).not.toBeNull();
  });
});

describe("AuthPage - registration gating", () => {
  it("hides the register form and shows a message when registration is disabled on the resolved server", () => {
    mockUseAuth.mockReturnValue({
      isFixedServerMode: true,
      homeServer: { origin: "http://localhost:4000", domain: "localhost", serverName: "Local", registrationEnabled: false },
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    });

    renderAuthPage("register");

    expect(screen.queryByText("Registration is disabled on this server.")).not.toBeNull();
    expect(screen.queryByPlaceholderText("username")).toBeNull();
  });
});
