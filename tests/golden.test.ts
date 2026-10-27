/**
 * The golden files in shared/golden/ are what the Python parity tests compare
 * against. If the TypeScript model changes without regenerating them, the two
 * implementations could drift apart unnoticed, so this fails until
 * `npm run golden` has been run.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { analyticalGolden, geometryGolden, reducedOrderGolden, serializeGolden } from "./golden/cases";

const stored = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../shared/golden/${name}`, import.meta.url)), "utf8"));

/** Through JSON, exactly as the generator writes it (drops undefined, keeps every digit). */
const current = (data: unknown): unknown => JSON.parse(serializeGolden(data));

describe("golden files are up to date with the TypeScript engines", () => {
  test("geometry", () => {
    expect(current(geometryGolden())).toEqual(stored("geometry.json"));
  });

  test("analytical engine and vehicle performance", () => {
    expect(current(analyticalGolden())).toEqual(stored("analytical.json"));
  });

  // Ten flow solves: a few seconds on an idle machine, more when something else is using the cores.
  test("reduced-order engine", () => {
    expect(current(reducedOrderGolden())).toEqual(stored("reduced-order.json"));
  }, 60000);
});
