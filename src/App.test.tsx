import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

// The Tauri window and OS APIs only exist inside the webview runtime.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => {
    throw new Error("not in a webview");
  },
}));

describe("App", () => {
  it("opens on an invitation to act", () => {
    render(<App />);
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByText("Start a session")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Start a scratch session" })).not.toHaveLength(0);
  });

  it("draws its own window controls, since the window is undecorated", () => {
    render(<App />);
    // Leaving these to the OS is what left Linux with no way to close the window.
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("offers the sidebar toggle", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /sidebar/i })).toBeInTheDocument();
  });
});
