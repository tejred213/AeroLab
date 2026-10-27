/**
 * Generates the cross-language golden files in shared/golden/ (npm run golden).
 *
 * The TypeScript engines are evaluated on a fixed set of cases and the results
 * are written to JSON. backend/tests/test_parity.py recomputes every case with
 * the Python engines and requires them to agree, which keeps the two
 * implementations of the physics locked together.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { analyticalGolden, geometryGolden, reducedOrderGolden, serializeGolden } from "./cases";

const OUTPUT_DIR = fileURLToPath(new URL("../../shared/golden/", import.meta.url));

function write(name: string, data: unknown): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}${name}`, serializeGolden(data));
}

test("generate geometry golden file", () => {
  write("geometry.json", geometryGolden());
});

test("generate analytical golden file", () => {
  write("analytical.json", analyticalGolden());
});

test("generate reduced-order golden file", () => {
  write("reduced-order.json", reducedOrderGolden());
});
