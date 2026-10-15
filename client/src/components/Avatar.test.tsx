import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Avatar from "./Avatar";

afterEach(cleanup);

const sam = { displayName: "Sam", avatarUrl: null };

describe("Avatar", () => {
  it("shows the first letter, upper-case, when there is no picture", () => {
    const { container } = render(<Avatar user={{ displayName: "  sam", avatarUrl: null }} />);

    expect(container.textContent).toBe("S");
  });

  it("shows a question mark for a name with no letters", () => {
    const { container } = render(<Avatar user={{ displayName: "  ", avatarUrl: null }} />);

    expect(container.textContent).toBe("?");
  });

  it("shows the picture when there is one", () => {
    const { container } = render(<Avatar user={{ displayName: "Sam", avatarUrl: "https://chat.example/uploads/sam.png" }} />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://chat.example/uploads/sam.png");
  });

  // The sizes themselves are CSS variables (--avatar-sm/md/xl); the component only picks the class.
  it("is the default size unless asked for another, with a class for each of the others", () => {
    const sizeClass = (size?: "sm" | "md" | "xl") => {
      const { container, unmount } = render(<Avatar user={sam} size={size} />);
      const className = (container.firstElementChild as HTMLElement).className;
      unmount();
      return className;
    };

    expect(sizeClass()).toBe("avatar");
    expect(sizeClass("md")).toBe("avatar");
    expect(sizeClass("sm")).toBe("avatar sm");
    expect(sizeClass("xl")).toBe("avatar xl");
  });
});
