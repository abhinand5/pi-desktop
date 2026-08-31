import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without `globals`, so Testing Library's automatic teardown never
// registers — every render would otherwise pile up in the same document.
afterEach(cleanup);
