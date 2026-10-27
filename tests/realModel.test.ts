/**
 * Command-line check of a downloaded model, without the browser:
 *
 *   AEROLAB_MODEL=public/cars/some_car.glb AEROLAB_CAR=land-rover-defender-110 npx vitest run tests/realModel.test.ts
 *
 * It measures the .glb the way the import page does (scaled by the linked car's
 * published wheelbase), runs Modes A and B on it and writes a report next to the
 * console output (AEROLAB_REPORT=path, default real-model-report.txt in the
 * system temp folder). Skipped when AEROLAB_MODEL is not set, so the normal test
 * run does not depend on any third-party file.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fitGeometry, guessOrientation, measureAtScale, SHAPE_PARAMS } from "@/lib/geometry/meshImport";
import { registerSampledBody } from "@/lib/geometry/sampledBody";
import { countOpenEdges, wrapModel, wrapToSoup } from "@/lib/geometry/wrap";
import { creditFromAsset } from "@/lib/import/specGloss";
import { STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { makeConfig } from "@/lib/simulation/config";
import { runReducedOrder } from "@/lib/simulation/reducedOrderEngine";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { readGlbTriangles } from "./glbReader";

const model = process.env.AEROLAB_MODEL;

it.skipIf(!model)("measures and solves a downloaded model", () => {
  const car = getBuiltInVehicle(process.env.AEROLAB_CAR ?? "land-rover-defender-110");
  const published = car.realCar!.published;
  const { triangles, parts, asset } = readGlbTriangles(model!);
  const orientation = guessOrientation(triangles, true);
  const { oriented, measured } = measureAtScale(triangles, orientation, { targetWheelbase: published.wheelbase }, "real-model");
  // As on the import page: what a surface cannot tell comes from the look-alike of the same car.
  const fitted = fitGeometry(measured, car.geometry);
  registerSampledBody(measured.body);

  const percent = (value: number, reference: number) => `${((value / reference - 1) * 100).toFixed(1)} %`;
  const wheelbase = measured.wheels ? measured.wheels.rearAxleX - measured.wheels.frontAxleX : Number.NaN;
  const lines = [
    `${model}: ${triangles.length / 9} triangles in ${parts} parts; credit ${JSON.stringify(creditFromAsset(asset))}`,
    `orientation ${JSON.stringify(orientation)}; scale ${oriented.scale.toFixed(4)}`,
    `body length ${measured.length.toFixed(3)} m (${percent(measured.length, published.length)} vs published), overall ${measured.overallLength.toFixed(3)} m, rear attachment ${measured.rearAttachment.toFixed(3)} m, tail squared ${measured.tailSquared.toFixed(3)} m`,
    `width ${measured.width.toFixed(3)} m (${percent(measured.width, published.width)}), height ${measured.height.toFixed(3)} m (${percent(measured.height, published.height)}), wheelbase ${wheelbase.toFixed(3)} m, tyre ${measured.wheels?.diameter.toFixed(3)} m, ride height ${measured.rideHeight.toFixed(3)} m`,
    `fitted (look-alike -> model): ${SHAPE_PARAMS.map((id) => `${id} ${car.geometry[id]} -> ${fitted.geometry[id].toFixed(3)}`).join(", ")}`,
    `notes: ${fitted.notes.join(" | ") || "none"}`,
    `published Cd ${published.cd ?? "n/a"}`,
  ];
  const speed = 130 / 3.6;
  for (const mode of ["analytical", "reduced-order"] as const) {
    const lookAlike = makeConfig(car, car.geometry, STANDARD_ENVIRONMENT, speed, mode, "coarse");
    const onModel = { ...lookAlike, geometry: fitted.geometry, bodyId: measured.body.id };
    for (const [label, config] of [["look-alike", lookAlike], ["3D model  ", onModel]] as const) {
      const aero = mode === "analytical" ? runAnalytical(config) : runReducedOrder(config).aero;
      lines.push(
        `${mode.padEnd(13)} ${label}  Cd ${aero.coefficients.cd.toFixed(3)} ± ${aero.uncertainty.cd.toFixed(3)}  Cl ${aero.coefficients.cl.toFixed(3)}  ` +
          `frontal area ${aero.metrics.frontalArea.toFixed(3)} m²  CdA ${(aero.coefficients.cd * aero.metrics.frontalArea).toFixed(3)} m²`,
      );
    }
  }
  // The closed surface Mode C would mesh. AEROLAB_WRAP_OUT=path also writes it (float32 triangles) with the
  // fitted geometry next to it (.json), which is what backend/tools/run_surface_case.py takes.
  const started = performance.now();
  const wrap = wrapModel(oriented.positions, { voxel: Number(process.env.AEROLAB_VOXEL ?? 0.015), seal: Number(process.env.AEROLAB_SEAL ?? 0.03) });
  lines.push(
    `wrap (${Math.round(wrap.voxel * 1000)} mm voxels, gaps to ${Math.round(wrap.seal * 1000)} mm sealed, ${((performance.now() - started) / 1000).toFixed(1)} s): ` +
      `${wrap.triangles} triangles, open edges ${countOpenEdges(wrap.indices)}, volume ${wrap.volume.toFixed(2)} m³, area ${wrap.area.toFixed(1)} m², ` +
      `frontal area ${wrap.frontalArea.toFixed(3)} m², fill ${wrap.fill.toFixed(2)}, extent ${wrap.min.map((v) => v.toFixed(2))} .. ${wrap.max.map((v) => v.toFixed(2))}` +
      (wrap.warnings.length ? ` | ${wrap.warnings.join(" ")}` : ""),
  );
  if (process.env.AEROLAB_WRAP_OUT) {
    const soup = wrapToSoup(wrap);
    writeFileSync(process.env.AEROLAB_WRAP_OUT, Buffer.from(soup.buffer, soup.byteOffset, soup.byteLength));
    writeFileSync(`${process.env.AEROLAB_WRAP_OUT}.json`, JSON.stringify({ vehicleId: car.id, geometry: fitted.geometry, wrap: { voxel: wrap.voxel, seal: wrap.seal } }));
  }
  const report = process.env.AEROLAB_REPORT ?? path.join(tmpdir(), "real-model-report.txt");
  writeFileSync(report, `${lines.join("\n")}\n`);
  expect(measured.wheels).not.toBeNull();
}, 600000);
