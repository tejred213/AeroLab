/** Writes the bundled sample model to public/cars/ (npm run golden). */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { buildSampleGlb, SAMPLE_FILE } from "../sampleModel";

test("generate the sample 3D model", () => {
  const directory = fileURLToPath(new URL("../../public/cars/", import.meta.url));
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}${SAMPLE_FILE}`, buildSampleGlb());
});
