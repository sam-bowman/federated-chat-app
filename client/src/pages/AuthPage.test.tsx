import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthPage from "./AuthPage";
import { DiscoveryError } from "../api/discovery";
import { getRecentAccounts, isRememberEnabled, rememberAccount } from "../lib/recentAccounts";

const mockUseAuth = vi.fn();
vi.mock("../context/AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
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

  // The address the API is reached at can be another host (api.chat.example.com) from the one in people's ids
  // (chat.example.com): showing it as "your identity" gets the wrong address copied and given to people.
  it("does not guess the domain from the API's address while discovery has not answered", () => {
    mockUseAuth.mockReturnValue({
      isFixedServerMode: true,
      homeServer: { origin: "https://api.chat.example.com", domain: "", serverName: "", registrationEnabled: true },
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    });

    const { container } = renderAuthPage("register");

    expect(container.textContent).not.toContain("api.chat.example.com");
    expect(container.textContent).not.toContain("localhost");
    expect(container.querySelector("code")!.textContent).toBe("@you:…");
  });

  it("shows the domain the server reported once discovery has answered, whatever host the API is on", () => {
    mockUseAuth.mockReturnValue({
      isFixedServerMode: true,
      homeServer: { origin: "https://api.chat.example.com", domain: "chat.example.com", serverName: "X", registrationEnabled: true },
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    });

    const { container } = renderAuthPage("register");

    expect(container.querySelector("code")!.textContent).toBe("@you:chat.example.com");
    expect(container.textContent).not.toContain("api.chat.example.com");
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

describe("AuthPage - 2FA challenge step", () => {
  function authStateWithLogin(login: ReturnType<typeof vi.fn>, verifyTotpLogin: ReturnType<typeof vi.fn>) {
    return {
      isFixedServerMode: true,
      homeServer: { origin: "http://localhost:4000", domain: "localhost", serverName: "Local", registrationEnabled: true },
      login,
      verifyTotpLogin,
      register: vi.fn(),
      resolveHomeServer: vi.fn(),
      switchServer: vi.fn(),
    };
  }

  it("shows the code step after login reports totpRequired, without navigating away", async () => {
    const login = vi.fn().mockResolvedValue({ totpRequired: true, challengeToken: "challenge-abc" });
    const verifyTotpLogin = vi.fn();
    mockUseAuth.mockReturnValue(authStateWithLogin(login, verifyTotpLogin));

    renderAuthPage("login");
    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByText("Sign in"));

    await waitFor(() => expect(screen.queryByText("Two-factor authentication")).not.toBeNull());
    expect(screen.queryByPlaceholderText("username")).toBeNull();
  });

  it("redeems the challenge with the entered code via verifyTotpLogin", async () => {
    const login = vi.fn().mockResolvedValue({ totpRequired: true, challengeToken: "challenge-abc" });
    const verifyTotpLogin = vi.fn().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue(authStateWithLogin(login, verifyTotpLogin));

    renderAuthPage("login");
    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByText("Sign in"));
    await waitFor(() => expect(screen.queryByText("Two-factor authentication")).not.toBeNull());

    fireEvent.change(screen.getByPlaceholderText("123456"), { target: { value: "654321" } });
    fireEvent.click(screen.getByText("Verify"));

    await waitFor(() => expect(verifyTotpLogin).toHaveBeenCalledWith("challenge-abc", { code: "654321" }));
  });

  it("switches to the recovery-code input and submits that field instead", async () => {
    const login = vi.fn().mockResolvedValue({ totpRequired: true, challengeToken: "challenge-abc" });
    const verifyTotpLogin = vi.fn().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue(authStateWithLogin(login, verifyTotpLogin));

    renderAuthPage("login");
    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByText("Sign in"));
    await waitFor(() => expect(screen.queryByText("Two-factor authentication")).not.toBeNull());

    fireEvent.click(screen.getByText("Use a recovery code instead"));
    fireEvent.change(screen.getByPlaceholderText("recovery code"), { target: { value: "abcd-ef01-2345" } });
    fireEvent.click(screen.getByText("Verify"));

    await waitFor(() =>
      expect(verifyTotpLogin).toHaveBeenCalledWith("challenge-abc", { recoveryCode: "abcd-ef01-2345" })
    );
  });

  it("'Back to sign in' returns to the username/password form", async () => {
    const login = vi.fn().mockResolvedValue({ totpRequired: true, challengeToken: "challenge-abc" });
    mockUseAuth.mockReturnValue(authStateWithLogin(login, vi.fn()));

    renderAuthPage("login");
    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByText("Sign in"));
    await waitFor(() => expect(screen.queryByText("Two-factor authentication")).not.toBeNull());

    fireEvent.click(screen.getByText("Back to sign in"));

    expect(screen.queryByPlaceholderText("username")).not.toBeNull();
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

describe("AuthPage - autofill hints", () => {
  const fixedServer = {
    isFixedServerMode: true,
    homeServer: { origin: "http://localhost:4000", domain: "localhost", serverName: "Local", registrationEnabled: true },
    login: vi.fn(),
    register: vi.fn(),
    resolveHomeServer: vi.fn(),
    switchServer: vi.fn(),
  };

  it("lets browsers and password managers save and fill the sign-in form", () => {
    mockUseAuth.mockReturnValue(fixedServer);
    renderAuthPage("login");

    const username = screen.getByPlaceholderText("username");
    const password = screen.getByPlaceholderText("password");
    expect(username.getAttribute("name")).toBe("username");
    expect(username.getAttribute("autocomplete")).toBe("username");
    expect(password.getAttribute("name")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
  });

  it("asks the password manager for a new password when registering", () => {
    mockUseAuth.mockReturnValue(fixedServer);
    renderAuthPage("register");

    expect(screen.getByPlaceholderText("username").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByPlaceholderText("password").getAttribute("autocomplete")).toBe("new-password");
  });

  it("marks the server box as a URL so the browser can suggest previous servers", () => {
    mockUseAuth.mockReturnValue({ ...fixedServer, isFixedServerMode: false, homeServer: null });
    renderAuthPage("login");

    expect(screen.getByPlaceholderText("@you:chat.example.com").getAttribute("autocomplete")).toBe("url");
  });
});

describe("AuthPage - remembered accounts", () => {
  const chat = { origin: "https://chat.example.com", domain: "chat.example.com", serverName: "My Chat Server" };
  const friends = { origin: "https://friends.example.org", domain: "friends.example.org", serverName: "Friends" };
  const resolvedChat = { ...chat, registrationEnabled: true };

  function pickerAuth(overrides: Record<string, unknown> = {}) {
    return {
      isFixedServerMode: false,
      homeServer: null,
      login: vi.fn(),
      register: vi.fn(),
      resolveHomeServer: vi.fn().mockResolvedValue(resolvedChat),
      switchServer: vi.fn(),
      ...overrides,
    };
  }

  function optionValues(container: HTMLElement, input: HTMLElement) {
    const list = container.querySelector(`datalist#${input.getAttribute("list")}`);
    return Array.from(list!.querySelectorAll("option")).map((o) => o.getAttribute("value"));
  }

  it("shows the plain 'Find your server' step when nothing is remembered", () => {
    mockUseAuth.mockReturnValue(pickerAuth());
    renderAuthPage("login");

    expect(screen.queryByText("Find your server")).not.toBeNull();
    expect(screen.queryByRole("list", { name: "Recent accounts" })).toBeNull();
  });

  it("lists remembered accounts, most recent first", () => {
    rememberAccount({ ...chat, username: "alice" }, 1000);
    rememberAccount({ ...friends, username: "bob" }, 2000);
    mockUseAuth.mockReturnValue(pickerAuth());
    renderAuthPage("login");

    expect(screen.queryByText("Welcome back")).not.toBeNull();
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("@bob:friends.example.org");
    expect(items[1].textContent).toContain("@alice:chat.example.com");
    expect(items[1].textContent).toContain("My Chat Server");
  });

  it("re-resolves the server through discovery and fills the username when an account is clicked", async () => {
    rememberAccount({ ...chat, username: "alice" }, 1000);
    const resolveHomeServer = vi.fn().mockResolvedValue(resolvedChat);
    const authState: any = pickerAuth({ resolveHomeServer });
    mockUseAuth.mockImplementation(() => authState);

    const { rerender } = renderAuthPage("login");
    fireEvent.click(screen.getByText("@alice:chat.example.com"));

    await waitFor(() => expect(resolveHomeServer).toHaveBeenCalledWith("https://chat.example.com"));
    authState.homeServer = resolvedChat;
    rerender(
      <MemoryRouter>
        <AuthPage mode="login" />
      </MemoryRouter>
    );

    expect((screen.getByPlaceholderText("username") as HTMLInputElement).value).toBe("alice");
  });

  it("shows the usual error and stays put when a remembered server is gone", async () => {
    rememberAccount({ ...chat, username: "alice" }, 1000);
    const resolveHomeServer = vi
      .fn()
      .mockRejectedValue(new DiscoveryError("network_error", "Couldn't reach that server."));
    mockUseAuth.mockReturnValue(pickerAuth({ resolveHomeServer }));
    renderAuthPage("login");

    fireEvent.click(screen.getByText("@alice:chat.example.com"));

    await waitFor(() => expect(screen.queryByText("Couldn't reach that server.")).not.toBeNull());
    expect(screen.queryByText("Welcome back")).not.toBeNull();
  });

  it("forgets one account, and the change is persisted", () => {
    rememberAccount({ ...chat, username: "alice" }, 1000);
    rememberAccount({ ...friends, username: "bob" }, 2000);
    mockUseAuth.mockReturnValue(pickerAuth());
    renderAuthPage("login");

    fireEvent.click(screen.getByLabelText("Forget @bob:friends.example.org"));

    expect(screen.queryByText("@bob:friends.example.org")).toBeNull();
    expect(screen.queryByText("@alice:chat.example.com")).not.toBeNull();
    expect(getRecentAccounts().map((a) => a.username)).toEqual(["alice"]);
  });

  it("suggests remembered servers in the server box", () => {
    rememberAccount({ ...chat, username: "alice" }, 1000);
    mockUseAuth.mockReturnValue(pickerAuth());
    const { container } = renderAuthPage("login");

    const input = screen.getByPlaceholderText("@you:chat.example.com");
    expect(optionValues(container, input)).toEqual(["chat.example.com"]);
  });

  it("preselects and suggests usernames used on this server only", () => {
    rememberAccount({ ...chat, username: "alice" }, 1000);
    rememberAccount({ ...chat, username: "alice2" }, 3000);
    rememberAccount({ ...friends, username: "bob" }, 2000);
    mockUseAuth.mockReturnValue(pickerAuth({ homeServer: resolvedChat }));
    const { container } = renderAuthPage("login");

    const input = screen.getByPlaceholderText("username") as HTMLInputElement;
    expect(input.value).toBe("alice2");
    expect(optionValues(container, input)).toEqual(["alice2", "alice"]);
  });

  it("offers username suggestions in fixed-server mode too, without the server picker", () => {
    rememberAccount({ origin: "http://localhost:4000", domain: "localhost", serverName: "Local", username: "alice" }, 1000);
    mockUseAuth.mockReturnValue(
      pickerAuth({
        isFixedServerMode: true,
        homeServer: { origin: "http://localhost:4000", domain: "localhost", serverName: "Local", registrationEnabled: true },
      })
    );
    renderAuthPage("login");

    expect((screen.getByPlaceholderText("username") as HTMLInputElement).value).toBe("alice");
    expect(screen.queryByRole("list", { name: "Recent accounts" })).toBeNull();
  });

  it("lets the user opt out of remembering this device", () => {
    mockUseAuth.mockReturnValue(pickerAuth({ homeServer: resolvedChat }));
    renderAuthPage("login");

    const checkbox = screen.getByLabelText("Remember this server and username on this device") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);

    expect(isRememberEnabled()).toBe(false);
  });

  it("ignores a corrupt stored list", () => {
    localStorage.setItem("chat.recentAccounts", "{not json");
    mockUseAuth.mockReturnValue(pickerAuth());
    renderAuthPage("login");

    expect(screen.queryByText("Find your server")).not.toBeNull();
  });
});
