import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EditEmoticonModal from "./EditEmoticonModal";

const updateEmoticon = vi.fn();
const uploadFile = vi.fn();
vi.mock("../api", () => ({
  updateEmoticon: (...args: unknown[]) => updateEmoticon(...args),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const emoticon = { id: "E1", name: "Frog", trigger: ":frog:", allowSave: true, allowFork: true };

function renderModal() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const utils = render(<EditEmoticonModal emoticon={emoticon} onSaved={onSaved} onClose={onClose} />);
  const saveButton = () => screen.getByText("Save changes") as HTMLButtonElement;
  const nameInput = () => screen.getByDisplayValue("Frog") as HTMLInputElement;
  return { ...utils, onSaved, onClose, saveButton, nameInput };
}

describe("EditEmoticonModal", () => {
  it("can't be saved until something has actually changed", () => {
    const { saveButton } = renderModal();
    expect(saveButton().disabled).toBe(true);
  });

  it("renaming sends just the new name - no upload", async () => {
    updateEmoticon.mockResolvedValue({});
    const { nameInput, saveButton, onSaved, onClose } = renderModal();

    fireEvent.change(nameInput(), { target: { value: "Big Frog" } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateEmoticon).toHaveBeenCalledWith("E1", {
      name: "Big Frog",
      imageUrl: undefined,
      allowSave: true,
      allowFork: true,
    });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("choosing a new image uploads it first, then sends its URL", async () => {
    uploadFile.mockResolvedValue({ url: "/uploads/new.png" });
    updateEmoticon.mockResolvedValue({});
    const { container, saveButton, onSaved } = renderModal();

    const file = new File(["x"], "new.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledWith(file);
    expect(updateEmoticon).toHaveBeenCalledWith("E1", {
      name: "Frog",
      imageUrl: "/uploads/new.png",
      allowSave: true,
      allowFork: true,
    });
  });

  it("starts with the emoticon's current save/fork settings", () => {
    render(
      <EditEmoticonModal
        emoticon={{ ...emoticon, allowSave: false, allowFork: true }}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect((screen.getByLabelText(/Save it/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Fork it/) as HTMLInputElement).checked).toBe(true);
  });

  it("turning off saving enables Save and sends only that flag change", async () => {
    updateEmoticon.mockResolvedValue({});
    const { saveButton, onSaved } = renderModal();

    fireEvent.click(screen.getByLabelText(/Save it/));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateEmoticon).toHaveBeenCalledWith("E1", {
      name: "Frog",
      imageUrl: undefined,
      allowSave: false,
      allowFork: true,
    });
  });

  it("can turn forking off on its own, and un-toggling goes back to nothing to save", () => {
    const { saveButton } = renderModal();
    const fork = screen.getByLabelText(/Fork it/);

    fireEvent.click(fork);
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(fork);
    expect(saveButton().disabled).toBe(true);
  });

  it("explains a failure and stays open so nothing is lost", async () => {
    updateEmoticon.mockRejectedValue(new Error("boom"));
    const { nameInput, saveButton, onSaved, onClose } = renderModal();

    fireEvent.change(nameInput(), { target: { value: "Big Frog" } });
    fireEvent.click(saveButton());

    await screen.findByText(/Couldn't save your changes/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
