import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Tabs from "./Tabs";

afterEach(cleanup);

const TABS = [
  { id: "friends", label: "Friends (3)" },
  { id: "incoming", label: "Incoming (0)" },
  { id: "blocked", label: "Blocked (1)" },
] as const;

type Id = (typeof TABS)[number]["id"];

/** Holds the selection the way the pages do, and shows a different thing under each tab. */
function Harness({ initial = "friends", onChange }: { initial?: Id; onChange?: (id: Id) => void }) {
  const [value, setValue] = useState<Id>(initial);
  return (
    <Tabs
      label="Friends"
      tabs={[...TABS]}
      value={value}
      onChange={(id) => {
        setValue(id);
        onChange?.(id);
      }}
    >
      <p>Content of {value}</p>
    </Tabs>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("Tabs: what is exposed", () => {
  it("is a tablist with a name, one tab per item, and a tabpanel", () => {
    render(<Harness />);

    expect(screen.getByRole("tablist", { name: "Friends" })).not.toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Friends (3)", "Incoming (0)", "Blocked (1)"]);
    expect(screen.getByRole("tabpanel")).not.toBeNull();
  });

  it("marks only the selected tab as selected", () => {
    render(<Harness initial="incoming" />);

    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tab("Incoming (0)").className).toContain("active");
    expect(tab("Friends (3)").className).not.toContain("active");
  });

  it("links the tabs to the panel and the panel back to the selected tab", () => {
    render(<Harness />);
    const panel = screen.getByRole("tabpanel");

    for (const t of screen.getAllByRole("tab")) expect(t.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Friends (3)").id);
    expect(screen.getByRole("tabpanel", { name: "Friends (3)" })).not.toBeNull();

    fireEvent.click(tab("Blocked (1)"));
    expect(screen.getByRole("tabpanel", { name: "Blocked (1)" })).not.toBeNull();
  });

  it("shows the content it is given inside the panel, with a minimum height", () => {
    render(<Harness />);

    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toBe("Content of friends");
    expect(panel.style.minHeight).toBe("12rem");
  });

  it("takes the panel's minimum height as a setting", () => {
    render(
      <Tabs label="x" tabs={[{ id: "a", label: "A" }]} value="a" onChange={vi.fn()} minHeight="20rem">
        body
      </Tabs>
    );

    expect(screen.getByRole("tabpanel").style.minHeight).toBe("20rem");
  });

  it("falls back to the first tab when the value is not one of them", () => {
    render(
      <Tabs label="x" tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} value={"gone" as "a"} onChange={vi.fn()}>
        body
      </Tabs>
    );

    expect(tab("A").getAttribute("aria-selected")).toBe("true");
    expect(tab("A").tabIndex).toBe(0);
  });
});

describe("Tabs: choosing with the mouse", () => {
  it("selects the clicked tab and shows its content", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(tab("Incoming (0)"));

    expect(onChange).toHaveBeenCalledWith("incoming");
    expect(screen.getByRole("tabpanel").textContent).toBe("Content of incoming");
  });
});

describe("Tabs: the keyboard", () => {
  // Roving focus: Tab lands on the selected tab only, so a strip of tabs is one stop, not several.
  it("puts only the selected tab in the tab order", () => {
    render(<Harness initial="incoming" />);

    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("moves to the next tab with ArrowRight, selecting it and focusing it", () => {
    render(<Harness />);
    tab("Friends (3)").focus();

    fireEvent.keyDown(tab("Friends (3)"), { key: "ArrowRight" });

    expect(tab("Incoming (0)").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Incoming (0)"));
    expect(screen.getByRole("tabpanel").textContent).toBe("Content of incoming");
  });

  it("moves back with ArrowLeft", () => {
    render(<Harness initial="incoming" />);

    fireEvent.keyDown(tab("Incoming (0)"), { key: "ArrowLeft" });

    expect(tab("Friends (3)").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Friends (3)"));
  });

  it("wraps round at both ends", () => {
    render(<Harness initial="blocked" />);

    fireEvent.keyDown(tab("Blocked (1)"), { key: "ArrowRight" });
    expect(tab("Friends (3)").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tab("Friends (3)"), { key: "ArrowLeft" });
    expect(tab("Blocked (1)").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Blocked (1)"));
  });

  it("jumps to the first and last with Home and End", () => {
    render(<Harness initial="incoming" />);

    fireEvent.keyDown(tab("Incoming (0)"), { key: "End" });
    expect(tab("Blocked (1)").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Blocked (1)"));

    fireEvent.keyDown(tab("Blocked (1)"), { key: "Home" });
    expect(tab("Friends (3)").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Friends (3)"));
  });

  it("leaves other keys alone", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.keyDown(tab("Friends (3)"), { key: "a" });
    fireEvent.keyDown(tab("Friends (3)"), { key: "ArrowDown" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // Enter and Space press a button natively (the browser turns them into a click).
  it("is made of real buttons, so Enter and Space work", () => {
    render(<Harness />);

    expect(screen.getAllByRole("tab").every((t) => t.tagName === "BUTTON")).toBe(true);
  });
});
