import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Markdown from "./Markdown";

describe("Markdown", () => {
  it("renders inline and display math through KaTeX", () => {
    const { container } = render(<Markdown text={"Inline $x^2$ math.\n\n$$\nE = mc^2\n$$"} />);

    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.querySelector(".katex-display")).toBeTruthy();
  });
});
