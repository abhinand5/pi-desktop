import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Composer from "./Composer";
import { bridge } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";
import { createWorkspace, project } from "../lib/store/workspace";

const originalClipboard = navigator.clipboard;

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
});


describe("Composer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const workspace = createWorkspace({ harness: "omp", cwd: "/tmp/project" });
    workspace.runtime = { id: "runtime-1", harness: "omp", pid: 1, exited: false, host: null };
    useAppStore.setState({
      ...project(workspace),
      workspaces: { [workspace.id]: workspace },
      workspaceOrder: [workspace.id],
      activeWorkspaceId: workspace.id,
      hosts: [],
      models: [],
      modelsError: null,
    });
    vi.spyOn(bridge, "gitStatus").mockResolvedValue({ isRepo: false, branch: null, changed: 0, staged: 0 });
    vi.spyOn(bridge, "request").mockResolvedValue({});
    vi.spyOn(bridge, "clipboardImage").mockRejectedValue(new Error("native clipboard unavailable"));
  });

  it("attaches an image when the clipboard exposes it through items", async () => {
    const image = new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" });

    render(<Composer />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        files: [],
        items: [{ kind: "file", type: image.type, getAsFile: () => image }],
      },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove clipboard.png" })).toBeInTheDocument());

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what is this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith("runtime-1", {
        type: "prompt",
        message: "what is this?",
        images: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }],
      }),
    );
  });

  it("attaches a native clipboard image when WebKit hides paste items", async () => {
    vi.mocked(bridge.clipboardImage).mockResolvedValue({ data: "iVBORw==", mimeType: "image/png" });

    render(<Composer />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [], items: [], types: ["text/plain"] },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove pasted-image.png" })).toBeInTheDocument());

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what is this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith("runtime-1", {
        type: "prompt",
        message: "what is this?",
        images: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }],
      }),
    );
  });

  it("reads an image through async clipboard when WebKit hides paste items", async () => {
    const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const read = vi.fn().mockResolvedValue([
      {
        types: ["image/png"],
        getType: vi.fn().mockResolvedValue(image),
      },
    ]);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } });

    render(<Composer />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [], items: [], types: [] },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove pasted-image-1.png" })).toBeInTheDocument());
    expect(read).toHaveBeenCalledTimes(1);
  });
});
