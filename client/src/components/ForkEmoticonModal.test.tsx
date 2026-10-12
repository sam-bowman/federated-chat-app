import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import ForkEmoticonModal from "./ForkEmoticonModal";

const forkEmoticon = vi.fn();
const uploadFile = vi.fn();
vi.mock("../api", () => ({
  forkEmoticon: (...args: unknown[]) => forkEmoticon(...args),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  mediaUrl: (p: string) => p,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const emoticon = { id: "E1", name: "Frog", trigger: ":frog:", imageUrl: "/uploads/frog.png" };

function renderModal() {
  const onForked = vi.fn();
  const onClose = vi.fn();
  const utils = render(<ForkEmoticonModal emoticon={emoticon} onForked={onForked} onClose={onClose} />);
  const triggerInput = () => screen.getByDisplayValue(":frog:") as HTMLInputElement;
  const submit = () => fireEvent.click(screen.getByText("Fork to my emoticons"));
  return { ...utils, onForked, onClose, triggerInput, submit };
}

describe("ForkEmoticonModal", () => {
  it("prefills the original's name and trigger, and forks without an image override by default", async () => {
    forkEmoticon.mockResolvedValue({});
    const { onForked, onClose, submit } = renderModal();

    submit();

    await waitFor(() => expect(onForked).toHaveBeenCalled());
    expect(forkEmoticon).toHaveBeenCalledWith("E1", { name: "Frog", trigger: ":frog:", imageUrl: undefined });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("adds the surrounding colons to a bare trigger", async () => {
    forkEmoticon.mockResolvedValue({});
    const { triggerInput, onForked, submit } = renderModal();

    fireEvent.change(triggerInput(), { target: { value: "myfrog" } });
    submit();

    await waitFor(() => expect(onForked).toHaveBeenCalled());
    expect(forkEmoticon).toHaveBeenCalledWith("E1", expect.objectContaining({ trigger: ":myfrog:" }));
  });

  it("uploads a chosen image first and forks with the uploaded URL", async () => {
    uploadFile.mockResolvedValue({ url: "/uploads/blue.png" });
    forkEmoticon.mockResolvedValue({});
    const { container, onForked, submit } = renderModal();

    const file = new File(["x"], "blue.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    submit();

    await waitFor(() => expect(onForked).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledWith(file);
    expect(forkEmoticon).toHaveBeenCalledWith("E1", expect.objectContaining({ imageUrl: "/uploads/blue.png" }));
  });

  it("explains a trigger clash and stays open", async () => {
    forkEmoticon.mockRejectedValue(new ApiError(409, { error: "trigger_already_in_use" }));
    const { onForked, onClose, submit } = renderModal();

    submit();

    await screen.findByText(/already have an emoticon using that trigger/);
    expect(onForked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("explains when the creator has turned forking off", async () => {
    forkEmoticon.mockRejectedValue(new ApiError(403, { error: "forking_not_allowed" }));
    const { submit } = renderModal();

    submit();

    await screen.findByText(/turned off forking/);
  });
});
