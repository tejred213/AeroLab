/**
 * Mode B — reduced-order engine.
 *
 * Numerically solved: 3D potential flow about the body and its wake
 * displacement body (potentialFlow.ts); surface pressure from Bernoulli,
 * integrated over the body to give pressure drag and lift.
 *
 * Empirical closures (same correlations as Mode A): separation location,
 * base pressure (blended with the pressure the solver finds along the wake
 * boundary), trailing-vortex drag, skin friction, wheel and underbody-roughness
 * drag, rear wing (lifting-line, using the local dynamic pressure from the
 * solved field), front splitter and crosswind forces.
 *
 * This is NOT CFD: there is no viscosity, turbulence or solved wake.
 *
 * backend/engines/reduced_order.py mirrors this file.
 */
import type { BreakdownItem, Fidelity, GeometryMetrics, SolverDiagnostics } from "@/lib/types";
import { DEG_TO_RAD, MODEL } from "@/lib/physics/model";
import {
  detailDragItems,
  type FlowState,
  frictionDrag,
  type LiftComponent,
  type RawAero,
  splitterEffect,
  sumLift,
  underbodyDrag,
  wheelDrag,
  wingEffect,
  yawEffects,
} from "@/lib/physics/aeroAnalytical";
import { computeRearFlow } from "@/lib/physics/rearFlow";
import { type BodyShape, lowerZ, wingGeometry } from "@/lib/geometry/profile";
import { buildSolidModel, insideBody, type SolidModel, wakeCoordinates } from "@/lib/geometry/solids";
import {
  type Apertures,
  buildGrid,
  cellVelocities,
  computeApertures,
  fidelitySettings,
  type Grid,
  markActiveCells,
  solvePotential,
} from "@/lib/simulation/potentialFlow";
import { CELL_FLUID, CELL_SOLID, CELL_WAKE, type FlowField } from "@/lib/simulation/field";

const RO = MODEL.reducedOrder;
const D = MODEL.drag;
const DIST = MODEL.liftDistribution;

export const REDUCED_ORDER_FIELD_PROVENANCE =
  "Reduced-order field: 3D potential flow (inviscid) on a cut-cell grid, with an empirical wake displacement body. " +
  "Velocities inside the wake and the turbulence estimate are synthetic. Not a CFD solution.";

export type SolveStage = "MESHING" | "SOLVING" | "POST_PROCESSING";

export interface ReducedOrderOptions {
  fidelity: Fidelity;
  /** Build the full flow field for visualisation (skipped for reference solves). */
  buildField: boolean;
  hash: string;
  onProgress?: (stage: SolveStage, fraction: number, message: string) => void;
}

export interface ReducedOrderOutput {
  raw: RawAero;
  field: FlowField | null;
  diagnostics: Omit<SolverDiagnostics, "rawCd" | "rawCl">;
}

interface Integrated {
  cdAttached: number;
  cdBase: number;
  clUpper: number;
  clLower: number;
  clUpperFront: number;
  clLowerFront: number;
}

/** Pressure the potential solution carries along the wake boundary just behind the tail. */
function wakeBoundaryPressure(
  grid: Grid,
  ap: Apertures,
  active: Uint8Array,
  cp: Float32Array,
  model: SolidModel,
): number | null {
  const { nx, ny, nz, xf, yf, zf, xc } = grid;
  const nxy = nx * ny;
  const xEnd = model.length + RO.basePressureSampleExtent * (model.wake.xc - model.length);
  let weightSum = 0;
  let cpSum = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (xc[i] < model.length || xc[i] > xEnd) continue;
        const c = i + nx * (j + ny * k);
        if (!active[c]) continue;
        const fx = i + (nx + 1) * (j + ny * k);
        const fy = i + nx * (j + (ny + 1) * k);
        const dx = xf[i + 1] - xf[i];
        const dy = yf[j + 1] - yf[j];
        const dz = zf[k + 1] - zf[k];
        // Area vector of the wake surface inside the cell = union surface minus real-solid surface.
        const sx = (ap.ux[fx] - ap.ux[fx + 1] - (ap.bx[fx] - ap.bx[fx + 1])) * dy * dz;
        const sy = (ap.uy[fy] - ap.uy[fy + nx] - (ap.by[fy] - ap.by[fy + nx])) * dx * dz;
        const sz = (ap.uz[c] - ap.uz[c + nxy] - (ap.bz[c] - ap.bz[c + nxy])) * dx * dy;
        const weight = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (weight <= 0) continue;
        weightSum += weight;
        cpSum += weight * cp[c];
      }
    }
  }
  return weightSum > 0 ? cpSum / weightSum : null;
}

/** Integrates surface pressure over the real solids. Returns coefficients referenced to `area`. */
function integratePressure(
  grid: Grid,
  ap: Apertures,
  active: Uint8Array,
  cp: Float32Array,
  fluidFraction: Float32Array,
  model: SolidModel,
  basePressure: number,
  area: number,
): Integrated {
  const { nx, ny, nz, xf, yf, zf, xc, yc, zc } = grid;
  const nxy = nx * ny;
  const { shape, ride } = model;
  const params = shape.params;
  const floorLoss = RO.underbodyLossRoughFloor + (1 - RO.underbodyLossRoughFloor) * params.floorFlatness;
  const scratch = new Float64Array(16);
  const halfWidth = 0.5 * params.width;

  let fxAttached = 0;
  let fxBase = 0;
  let fzUpper = 0;
  let fzLower = 0;
  let mUpper = 0;
  let mLower = 0;

  for (let k = 0; k < nz; k++) {
    const dz = zf[k + 1] - zf[k];
    for (let j = 0; j < ny; j++) {
      const dy = yf[j + 1] - yf[j];
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        const fx = i + (nx + 1) * (j + ny * k);
        const fy = i + nx * (j + (ny + 1) * k);
        const bxm = i > 0 ? ap.bx[fx] : 1;
        const bxp = i < nx - 1 ? ap.bx[fx + 1] : 1;
        const bzm = ap.bz[c];
        const bzp = k < nz - 1 ? ap.bz[c + nxy] : 1;
        const dx = xf[i + 1] - xf[i];
        // Area vector of the body surface inside the cell, pointing into the solid.
        const sx = (bxm - bxp) * dy * dz;
        const sz = (bzm - bzp) * dx * dy;
        if (sx === 0 && sz === 0) continue;

        const bym = j > 0 ? ap.by[fy] : 1;
        const byp = j < ny - 1 ? ap.by[fy + nx] : 1;
        const bodyFraction = (bxm + bxp + bym + byp + bzm + bzp) / 6;
        // Share of the cell's fluid that belongs to the outer flow rather than the wake.
        const outer = active[c] ? Math.min(fluidFraction[c] / Math.max(bodyFraction, 1e-6), 1) : 0;

        let cpOuter = cp[c];
        // Underbody cells: a rough floor slows the flow, weakening the pressure signal.
        if (
          xc[i] >= 0 &&
          xc[i] <= model.length &&
          Math.abs(yc[j]) <= halfWidth &&
          zc[k] < ride + lowerZ(shape, xc[i]) &&
          !insideBody(model, xc[i], yc[j], zc[k], scratch)
        ) {
          cpOuter *= floorLoss;
        }

        fxAttached += outer * cpOuter * sx;
        fxBase += (1 - outer) * basePressure * sx;
        const fz = (outer * cpOuter + (1 - outer) * basePressure) * sz;
        // Fraction of a vertical load at x carried by the front axle.
        const front = (shape.rearAxleX - xc[i]) / params.wheelbase;
        if (sz < 0) {
          fzUpper += fz;
          mUpper += fz * front;
        } else {
          fzLower += fz;
          mLower += fz * front;
        }
      }
    }
  }
  const scale = (grid.symmetric ? 2 : 1) / area;
  return {
    cdAttached: fxAttached * scale,
    cdBase: fxBase * scale,
    clUpper: fzUpper * scale,
    clLower: fzLower * scale,
    clUpperFront: mUpper * scale,
    clLowerFront: mLower * scale,
  };
}

/** Local-to-freestream dynamic pressure ratio at the rear wing, from the solved field. */
function wingDynamicPressure(
  grid: Grid,
  active: Uint8Array,
  speedSquared: Float32Array,
  shape: BodyShape,
): number | undefined {
  const wing = wingGeometry(shape);
  if (!wing.present) return undefined;
  const { nx, ny, xf, yf, zf } = grid;
  const locate = (faces: Float64Array, value: number) => {
    let index = 0;
    while (index < faces.length - 2 && faces[index + 1] <= value) index++;
    return index;
  };
  const i = locate(xf, wing.xc);
  const j = locate(yf, wing.span / 4);
  const k = locate(zf, shape.params.rideHeight + wing.zc);
  const c = i + nx * (j + ny * k);
  if (!active[c]) return undefined;
  return Math.min(Math.max(speedSquared[c], 0.2), 1.5);
}

function buildField(
  grid: Grid,
  active: Uint8Array,
  velocity: { u: Float32Array; v: Float32Array; w: Float32Array },
  cp: Float32Array,
  model: SolidModel,
  basePressure: number,
  flow: FlowState,
  options: ReducedOrderOptions,
): FlowField {
  const { nx, ny, nz, xc, yc, zc } = grid;
  const total = nx * ny * nz;
  const kind = new Uint8Array(total);
  const ti = new Float32Array(total);
  const scratch = new Float64Array(16);
  const { u, v, w } = velocity;
  const extent = RO.wakeRecirculationExtent;
  const wakeStart = model.length;
  const wakeSpan = model.wake.xc - model.length;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (active[c]) {
          kind[c] = CELL_FLUID;
          ti[c] = 0.005;
          continue;
        }
        const x = xc[i];
        const y = yc[j];
        const z = zc[k];
        const coords = insideBody(model, x, y, z, scratch) ? null : wakeCoordinates(model, x, y, z);
        if (!coords) {
          kind[c] = CELL_SOLID;
          continue;
        }
        // Synthetic recirculation: a counter-rotating vortex pair with reversed flow on the
        // wake centreline, relaxing to a forward-moving velocity deficit further downstream.
        kind[c] = CELL_WAKE;
        const xl = Math.min(Math.max((x - wakeStart) / wakeSpan, 0), 1);
        const bubble = Math.min(xl / extent, 1);
        const envelope = Math.sin(Math.PI * bubble);
        const lateral = 1 - coords.eta * coords.eta;
        const swirl = RO.wakeRecirculation * lateral;
        u[c] = 0.5 * xl * xl + swirl * envelope * Math.cos(2 * Math.PI * coords.zeta);
        v[c] = 0;
        w[c] =
          xl < extent
            ? -swirl *
              (coords.height / (2 * extent * wakeSpan)) *
              Math.cos(Math.PI * bubble) *
              Math.sin(2 * Math.PI * coords.zeta)
            : 0;
        cp[c] = basePressure;
        ti[c] = 0.1 + 0.2 * envelope * lateral;
      }
    }
  }

  return {
    nx,
    ny,
    nz,
    xc: Float32Array.from(xc),
    yc: Float32Array.from(yc),
    zc: Float32Array.from(zc),
    u,
    v,
    w,
    cp,
    ti,
    kind,
    symmetric: grid.symmetric,
    bounds: { xMin: grid.xf[0], xMax: grid.xf[nx], yMax: grid.yf[ny], zMax: grid.zf[nz] },
    freestream: { speed: flow.speed, yawDeg: flow.yawDeg },
    provenance: REDUCED_ORDER_FIELD_PROVENANCE,
    fidelity: options.fidelity,
    hash: options.hash,
  };
}

/** Solves the potential flow for one geometry and returns uncalibrated coefficients (and the field). */
export function solveReducedOrder(
  shape: BodyShape,
  metrics: GeometryMetrics,
  flow: FlowState,
  options: ReducedOrderOptions,
): ReducedOrderOutput {
  const report = options.onProgress ?? (() => {});
  const settings = fidelitySettings(options.fidelity);
  const area = metrics.frontalArea;
  const rearFlow = computeRearFlow(shape, area);

  report("MESHING", 0, "Generating cut-cell grid");
  const symmetric = Math.abs(flow.yawDeg) < 1e-6;
  const grid = buildGrid(
    {
      length: metrics.length,
      width: shape.params.width,
      rideHeight: shape.params.rideHeight,
      roofHeight: shape.params.roofHeight,
    },
    options.fidelity,
    symmetric,
  );
  const model = buildSolidModel(shape, rearFlow, { x: 1.2 * settings.hx, y: 1.2 * settings.hy });
  const apertures = computeApertures(grid, model);
  const active = markActiveCells(grid, apertures);
  let fluidCells = 0;
  for (let c = 0; c < active.length; c++) fluidCells += active[c];

  report("SOLVING", 0, "Solving potential flow");
  const solution = solvePotential(grid, apertures, active, {
    yawDeg: flow.yawDeg,
    tolerance: settings.tolerance,
    onProgress: (fraction, iteration, residual) =>
      report("SOLVING", fraction, `Solving potential flow · iteration ${iteration} · residual ${residual.toExponential(1)}`),
  });

  report("POST_PROCESSING", 0, "Integrating surface pressure");
  const velocity = cellVelocities(grid, apertures, active, solution.phi, flow.yawDeg);
  const total = grid.nx * grid.ny * grid.nz;
  const cp = new Float32Array(total);
  const speedSquared = new Float32Array(total);
  for (let c = 0; c < total; c++) {
    if (!active[c]) continue;
    const s2 = velocity.u[c] * velocity.u[c] + velocity.v[c] * velocity.v[c] + velocity.w[c] * velocity.w[c];
    speedSquared[c] = s2;
    // Bernoulli: Cp = 1 - (V / V_inf)^2, bounded below to tame corner singularities.
    cp[c] = Math.max(1 - s2, RO.cpFloor);
  }

  const fieldPressure = wakeBoundaryPressure(grid, apertures, active, cp, model);
  const empiricalBase = rearFlow.basePressureCoefficient;
  const basePressure =
    fieldPressure === null
      ? empiricalBase
      : RO.basePressureBlend * empiricalBase +
        (1 - RO.basePressureBlend) * Math.min(Math.max(fieldPressure, RO.basePressureMin), RO.basePressureMax);

  const integrated = integratePressure(
    grid,
    apertures,
    active,
    cp,
    velocity.fluidFraction,
    model,
    basePressure,
    area,
  );

  const wing = wingEffect(shape, metrics, wingDynamicPressure(grid, active, speedSquared, shape));
  const splitter = splitterEffect(shape, metrics);
  const cdFriction = frictionDrag(metrics, flow);

  const drag: BreakdownItem[] = [
    { id: "pressure", label: "Surface pressure, attached flow (integrated)", value: integrated.cdAttached },
    { id: "base", label: "Base pressure on separated surfaces (integrated)", value: integrated.cdBase },
    { id: "vortex", label: "Rear-slant trailing vortices (closure)", value: rearFlow.vortexDrag },
    { id: "underbody", label: "Underbody roughness (closure)", value: underbodyDrag(shape) },
    { id: "wheels", label: "Wheels and wheelhouses (closure)", value: wheelDrag(shape, metrics) },
    { id: "friction", label: "Skin friction (closure)", value: cdFriction },
    ...detailDragItems(shape, metrics),
    { id: "wing", label: "Rear wing (lifting-line)", value: wing.cd },
    { id: "splitter", label: "Front splitter (closure)", value: splitter.cd },
  ];
  // Trailing vortices are not part of a potential solution. Their lift is tied to their drag
  // through the slant angle (the vortex force acts normal to the slanted surface).
  const vortexLift =
    rearFlow.vortexDrag / Math.tan(Math.max(rearFlow.effectiveSlantDeg, 8) * DEG_TO_RAD);
  const frontShare = (front: number, total2: number) => (Math.abs(total2) > 1e-9 ? front / total2 : 0.5);
  const lift: LiftComponent[] = [
    {
      id: "upper",
      label: "Upper-surface pressure (integrated)",
      value: integrated.clUpper,
      front: frontShare(integrated.clUpperFront, integrated.clUpper),
    },
    {
      id: "lower",
      label: "Underbody pressure (integrated)",
      value: integrated.clLower,
      front: frontShare(integrated.clLowerFront, integrated.clLower),
    },
    { id: "vortex", label: "Rear-slant vortex lift (closure)", value: vortexLift, front: DIST.slant },
    { id: "wing", label: "Rear wing (lifting-line)", value: wing.cl, front: DIST.wing },
    { id: "splitter", label: "Front splitter (closure)", value: splitter.cl, front: DIST.splitter },
  ];

  const cdZeroYaw = drag.reduce((sum, item) => sum + item.value, 0);
  const yaw = yawEffects(shape, metrics, cdZeroYaw, flow.yawDeg);
  drag.push({ id: "yaw", label: "Yaw-induced (closure)", value: yaw.cdIncrement });
  lift.push({ id: "yaw", label: "Yaw-induced (closure)", value: yaw.clIncrement, front: DIST.yaw });
  const totals = sumLift(lift);

  const raw: RawAero = {
    cd: cdZeroYaw + yaw.cdIncrement,
    cl: totals.cl,
    clFront: totals.clFront,
    clRear: totals.clRear,
    cs: yaw.cs,
    cmYaw: yaw.cmYaw,
    cdFriction,
    drag,
    lift,
    rearFlow: { ...rearFlow, basePressureCoefficient: basePressure },
  };

  const field = options.buildField
    ? buildField(grid, active, velocity, cp, model, basePressure, flow, options)
    : null;

  return {
    raw,
    field,
    diagnostics: {
      cells: total,
      fluidCells,
      iterations: solution.iterations,
      residual: solution.residual,
      converged: solution.converged,
      gridSize: [grid.nx, grid.ny, grid.nz],
      blockageRatio: area / (2 * MODEL.tunnel.halfWidth * MODEL.tunnel.height),
      pressureDragAttached: integrated.cdAttached,
      basePressureFromField: fieldPressure ?? Number.NaN,
    },
  };
}
