import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import DataExportSection from "./DataExportSection";

const exportMyData = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ exportMyData }));

beforeEach(() => {
  exportMyData.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const type = (value: string) => fireEvent.change(screen.getByLabelText("Your password"), { target: { value } });

describe("Settings -> Your data", () => {
  it("cannot be asked for until a password is typed, and never fills one in for you", () => {
    render(<DataExportSection />);
    expect((screen.getByRole("button", { name: "Download my data" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Your password").getAttribute("type")).toBe("password");
    type("secret");
    expect((screen.getByRole("button", { name: "Download my data" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks with the password, saves the file under the name the server gave, and forgets the password", async () => {
    exportMyData.mockResolvedValue({ blob: new Blob(["{}"]), filename: "chat-export-alice-2026-10-21.json" });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    render(<DataExportSection />);
    type("Correct-Horse-1!");
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved chat-export-alice-2026-10-21.json."));
    expect(exportMyData).toHaveBeenCalledWith("Correct-Horse-1!");
    expect(clicked).toEqual(["chat-export-alice-2026-10-21.json"]);
    expect((screen.getByLabelText("Your password") as HTMLInputElement).value).toBe("");
    click.mockRestore();
  });

  it("uses a name of its own when the server gives none", async () => {
    exportMyData.mockResolvedValue({ blob: new Blob(["{}"]), filename: null });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<DataExportSection />);
    type("x");
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved chat-export.json."));
    click.mockRestore();
  });

  it("says the password is wrong, keeps it to correct, and saves nothing", async () => {
    exportMyData.mockRejectedValue(new ApiError(401, { error: "invalid_credentials" }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<DataExportSection />);
    type("wrong");
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(screen.getByText("That is not your password.")).not.toBeNull());
    expect(click).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Your password") as HTMLInputElement).value).toBe("wrong");
    click.mockRestore();
  });

  it("says when it is being asked too often, and when something else went wrong", async () => {
    exportMyData.mockRejectedValueOnce(new ApiError(429, null)).mockRejectedValueOnce(new Error("offline"));
    render(<DataExportSection />);
    type("x");
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(screen.getByText(/Too many tries/)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(screen.getByText("Couldn't get your data. Try again.")).not.toBeNull());
  });
});
