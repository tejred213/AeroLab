import { describe, expect, test } from "vitest";
import { describeChanges, formatParam } from "@/lib/utils/describe";
import { slug, toCsv } from "@/lib/utils/export";
import { resampleSeries } from "@/lib/utils/series";
import {
  formatNumber,
  formatSigned,
  formatValue,
  formatWithUnit,
  type Quantity,
  quantityOfParam,
  unitOf,
  type UnitSystem,
} from "@/lib/utils/units";
import { getBuiltInVehicle } from "@/lib/vehicle/library";

const QUANTITIES: Quantity[] = [
  "length",
  "distance",
  "area",
  "speed",
  "acceleration",
  "force",
  "pressure",
  "power",
  "torque",
  "energy",
  "mass",
  "density",
  "temperature",
  "angle",
  "ratio",
  "time",
  "rpm",
  "moment",
];

describe("unit conversion", () => {
  test("every quantity converts to display units and back without loss", () => {
    for (const system of ["si", "automotive"] as UnitSystem[]) {
      for (const quantity of QUANTITIES) {
        const unit = unitOf(system, quantity);
        for (const value of [0, 1, 41.6667, 288.15, 101325, 147000]) {
          expect(unit.fromDisplay(unit.toDisplay(value))).toBeCloseTo(value, 6);
        }
      }
    }
  });

  test("automotive units use the conventional factors", () => {
    expect(unitOf("automotive", "speed").toDisplay(150 / 3.6)).toBeCloseTo(150, 9);
    expect(unitOf("automotive", "speed").fromDisplay(100)).toBeCloseTo(27.7778, 4);
    expect(unitOf("automotive", "length").toDisplay(0.07)).toBeCloseTo(70, 9);
    expect(unitOf("automotive", "power").toDisplay(100000)).toBeCloseTo(135.96, 2);
    expect(unitOf("automotive", "temperature").toDisplay(288.15)).toBeCloseTo(15, 9);
    expect(unitOf("automotive", "temperature").fromDisplay(-40)).toBeCloseTo(233.15, 9);
    expect(unitOf("automotive", "pressure").toDisplay(101325)).toBeCloseTo(1.01325, 9);
    expect(unitOf("automotive", "energy").toDisplay(3.6e6)).toBeCloseTo(1, 9);
    expect(unitOf("automotive", "distance").toDisplay(420000)).toBeCloseTo(420, 9);
    // Force stays in newtons in both systems.
    expect(unitOf("automotive", "force").label).toBe("N");
    expect(unitOf("si", "power").toDisplay(100000)).toBeCloseTo(100, 9);
    expect(unitOf("si", "speed").label).toBe("m/s");
  });

  test("geometry parameters map to a display quantity", () => {
    expect(quantityOfParam("length")).toBe("length");
    expect(quantityOfParam("angle")).toBe("angle");
    expect(quantityOfParam("ratio")).toBe("ratio");
  });
});

describe("number formatting", () => {
  test("values are shown in display units with their label", () => {
    expect(formatWithUnit("automotive", "speed", 150 / 3.6)).toBe("150 km/h");
    expect(formatWithUnit("si", "speed", 150 / 3.6)).toBe("41.7 m/s");
    expect(formatWithUnit("automotive", "length", 0.1)).toBe("100 mm");
    expect(formatWithUnit("si", "length", 0.1)).toBe("0.100 m");
    expect(formatWithUnit("si", "ratio", 0.5)).toBe("0.50");
    expect(formatValue("si", "force", 412.6)).toBe("413");
    expect(formatValue("si", "force", 412.6, 1)).toBe("412.6");
  });

  test("missing or non-finite values are shown as a dash, never as a number", () => {
    for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatValue("si", "force", missing)).toBe("—");
      expect(formatWithUnit("automotive", "speed", missing)).toBe("—");
      expect(formatNumber(missing)).toBe("—");
      expect(formatSigned(missing)).toBe("—");
    }
  });

  test("signed differences carry an explicit sign and never show negative zero", () => {
    expect(formatSigned(0.0124)).toBe("+0.012");
    expect(formatSigned(-0.008)).toBe("−0.008");
    expect(formatSigned(-0.0001)).toBe("0.000");
    expect(formatSigned(0)).toBe("0.000");
    expect(formatSigned(-12.4, 0)).toBe("−12");
    expect(formatNumber(0.27)).toBe("0.270");
    expect(formatNumber(0.27, 2)).toBe("0.27");
  });
});

describe("change descriptions", () => {
  const base = getBuiltInVehicle("fastback").geometry;

  test("each changed parameter is listed with its difference in display units", () => {
    expect(describeChanges("automotive", base, base)).toEqual([]);
    const lowered = { ...base, rideHeight: base.rideHeight - 0.03, spoilerAngle: base.spoilerAngle + 12 };
    expect(describeChanges("automotive", base, lowered).sort()).toEqual(["Rear spoiler angle +12.0 °", "Ride height −30 mm"]);
    expect(describeChanges("si", base, { ...base, rideHeight: base.rideHeight - 0.03 })).toEqual(["Ride height −0.030 m"]);
    expect(formatParam("automotive", "rideHeight", 0.07)).toBe("70 mm");
    expect(formatParam("si", "floorFlatness", 0.8)).toBe("0.80");
  });
});

describe("export helpers", () => {
  test("CSV cells are quoted only when they need to be", () => {
    expect(toCsv(["a", "b"], [[1, "plain"]])).toBe("a,b\n1,plain");
    expect(toCsv(["name", "note"], [["Run 1", 'said "hi", twice'], ["Run 2", null], ["Run 3", "two\nlines"]])).toBe(
      'name,note\nRun 1,"said ""hi"", twice"\nRun 2,\nRun 3,"two\nlines"',
    );
  });

  test("file names are derived safely from titles", () => {
    expect(slug("Fastback — ride 70 mm / Spoiler 12°")).toBe("fastback-ride-70-mm-spoiler-12");
    expect(slug("  ../../etc/passwd ")).toBe("etc-passwd");
    expect(slug("x".repeat(100)).length).toBe(60);
  });
});

describe("overlaying curves sampled at different x values", () => {
  const short = { key: "a", points: [0, 10, 20].map((x) => ({ x, y: 2 * x })) };
  const long = { key: "b", points: [0, 7, 14, 21, 28, 35].map((x) => ({ x, y: 100 - x })) };

  test("every curve is interpolated onto one shared grid", () => {
    const rows = resampleSeries([short, long], 36);
    expect(rows.length).toBe(36);
    expect(rows[0]).toEqual({ x: 0, a: 0, b: 100 });
    expect(rows[35].x).toBe(35);
    for (const row of rows) {
      const x = row.x as number;
      expect(row.b).toBeCloseTo(100 - x, 9);
      if (x <= 20) expect(row.a).toBeCloseTo(2 * x, 9);
    }
    // Consecutive rows carry both curves, so each draws as an unbroken line.
    expect(rows.slice(0, 20).every((row) => row.a !== null && row.b !== null)).toBe(true);
  });

  test("a curve is never extrapolated beyond its own samples", () => {
    const rows = resampleSeries([short, long], 36);
    expect(rows.filter((row) => (row.x as number) > 20).every((row) => row.a === null)).toBe(true);
    expect(rows.every((row) => row.b !== null)).toBe(true);
  });

  test("degenerate input gives no rows rather than invented ones", () => {
    expect(resampleSeries([])).toEqual([]);
    expect(resampleSeries([{ key: "a", points: [{ x: 1, y: 1 }] }])).toEqual([]);
    expect(resampleSeries([{ key: "a", points: [{ x: 3, y: 1 }, { x: 3, y: 2 }] }])).toEqual([]);
  });
});
