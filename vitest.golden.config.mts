import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Regenerates shared/golden/*.json from the TypeScript engines: `npm run golden`.
// The Python test-suite checks its own engines against these files.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/golden/**/*.golden.ts"],
    testTimeout: 600000,
  },
});
