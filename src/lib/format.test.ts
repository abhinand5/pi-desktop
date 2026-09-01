import { describe, expect, it } from "vitest";
import { formatCost } from "./format";

describe("formatCost", () => {
  it("keeps a cheap session legible instead of rounding it to zero", () => {
    // Two decimals — what the usage page used to hardcode — reports all three
    // of these as "$0.00".
    expect(formatCost(0.003)).toBe("$0.0030");
    expect(formatCost(0.035)).toBe("$0.035");
    expect(formatCost(0.0004)).toBe("$0.0004");
  });

  it("keeps an expensive one readable", () => {
    expect(formatCost(1.8432)).toBe("$1.84");
    expect(formatCost(0.52)).toBe("$0.52");
    expect(formatCost(124.5)).toBe("$124.50");
  });

  it("says nothing rather than guessing when the harness reports no cost", () => {
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0)).toBe("$0");
  });
});
