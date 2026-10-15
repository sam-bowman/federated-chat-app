import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Button from "./Button";

afterEach(cleanup);

describe("Button", () => {
  it("is the primary regular button by default", () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toBe("btn");
  });

  it.each([
    ["secondary", "btn btn-secondary"],
    ["danger", "btn btn-danger"],
    ["ghost", "btn btn-ghost"],
    ["link", "btn btn-link"],
  ] as const)("maps the %s variant to its class", (variant, expected) => {
    render(<Button variant={variant}>Go</Button>);

    expect(screen.getByRole("button").className).toBe(expected);
  });

  it("adds the compact class for size sm, and keeps an extra class", () => {
    render(
      <Button size="sm" className="role-chip">
        Go
      </Button>
    );

    expect(screen.getByRole("button").className).toBe("btn btn-sm role-chip");
  });

  // A raw <button> in a form submits it; here that has to be asked for.
  it("does not submit a form unless it is type=submit", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Cancel</Button>
        <Button type="submit">Save</Button>
      </form>
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does nothing when clicked while disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Go
      </Button>
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).not.toHaveBeenCalled();
  });

  // Waiting on the server: still labelled, but it cannot be pressed again and says it is busy.
  it("is disabled and announced as busy while busy, and normal again after", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button busy onClick={onClick}>
        Saving
      </Button>
    );
    const button = screen.getByRole("button", { name: "Saving" }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <Button busy={false} onClick={onClick}>
        Saving
      </Button>
    );
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("passes other attributes through, layout styles included", () => {
    render(
      <Button aria-label="Remove" title="Remove it" style={{ alignSelf: "flex-start" }}>
        ×
      </Button>
    );

    const button = screen.getByRole("button", { name: "Remove" });
    expect(button.getAttribute("title")).toBe("Remove it");
    expect(button.style.alignSelf).toBe("flex-start");
  });
});
