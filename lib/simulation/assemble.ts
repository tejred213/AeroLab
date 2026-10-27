/**
 * Shared set-up and result assembly for the aerodynamic engines.
 *
 * Calibration ("anchor and delta"): each vehicle class has approximate reference
 * coefficients. An engine evaluates both the user's geometry and the class
 * reference geometry; the reported coefficient is
 *
 *     C = C_reference + [ C_model(geometry) - C_model(reference geometry) ]
 *
 * so the simplified model only has to predict the *change* caused by a
 * modification. The offset is reported explicitly in the drag breakdown.
 *
 * backend/simulation/assemble.py mirrors this file.
 */
import {
  type AeroResult,
  type BreakdownItem,
  type GeometryMetrics,
  type SimulationConfig,
  type SimulationMode,
  SimulationError,
  type SolverDiagnostics,
} from "@/lib/types";
import { MODEL } from "@/lib/physics/model";
import { type AirState, airViscosity, reynoldsNumber, resolveAir } from "@/lib/physics/atmosphere";
import { coefficientForce, dynamicPressure } from "@/lib/physics/forces";
import { relativeWind, type RelativeWind } from "@/lib/physics/wind";
import { type BodyShape, buildBodyShape } from "@/lib/geometry/profile";
import { shapeFor } from "@/lib/geometry/sampledBody";
import { computeMetrics } from "@/lib/geometry/metrics";
import { validateGeometry } from "@/lib/geometry/validate";
import type { FlowState, RawAero } from "@/lib/physics/aeroAnalytical";
import { sanityWarnings } from "@/lib/simulation/sanity";

export interface PreparedCase {
  shape: BodyShape;
  metrics: GeometryMetrics;
  referenceShape: BodyShape;
  referenceMetrics: GeometryMetrics;
  air: AirState;
  wind: RelativeWind;
  /** Onset flow for the user's case. */
  flow: FlowState;
  /** Standard-air, zero-yaw flow at the calibration speed, used for the reference geometry. */
  calibrationFlow: FlowState;
}

/** Validates the configuration and derives everything the engines need. Throws SimulationError. */
export function prepareCase(config: SimulationConfig): PreparedCase {
  const issues = validateGeometry(config.geometry).filter((issue) => issue.severity === "error");
  if (issues.length > 0) {
    throw new SimulationError("INVALID_GEOMETRY", issues.map((issue) => issue.message).join(" "));
  }
  const referenceIssues = validateGeometry(config.referenceGeometry).filter((issue) => issue.severity === "error");
  if (referenceIssues.length > 0) {
    throw new SimulationError("INVALID_REFERENCE_GEOMETRY", "The reference geometry of this vehicle is invalid.");
  }
  if (!Number.isFinite(config.speed) || config.speed < 0) {
    throw new SimulationError("INVALID_CONDITIONS", "Vehicle speed must be a non-negative number.");
  }
  const air = resolveAir(config.environment);
  if (!Number.isFinite(air.density) || air.density <= 0 || air.density > 5) {
    throw new SimulationError("INVALID_CONDITIONS", `Air density ${air.density} kg/m^3 is not physical.`);
  }
  const wind = relativeWind(config.speed, config.environment.windSpeed, config.environment.windAngle);

  const shape = shapeFor(config.geometry, config.bodyId);
  const referenceShape = buildBodyShape(config.referenceGeometry);
  return {
    shape,
    metrics: computeMetrics(shape),
    referenceShape,
    referenceMetrics: computeMetrics(referenceShape),
    air,
    wind,
    flow: { speed: wind.relativeSpeed, yawDeg: wind.yawAngleDeg, density: air.density, viscosity: air.viscosity },
    calibrationFlow: {
      speed: MODEL.calibration.speed,
      yawDeg: 0,
      density: 1.225,
      viscosity: airViscosity(288.15),
    },
  };
}

export interface AssembleInput {
  config: SimulationConfig;
  prepared: PreparedCase;
  raw: RawAero;
  rawReference: RawAero;
  mode: SimulationMode;
  source: "browser" | "backend";
  provenance: string;
  uncertaintyModel: { cdRelative: number; cdDelta: number; clAbsolute: number; clDelta: number };
  assumptions: string[];
  solver?: SolverDiagnostics;
}

export function assembleResult(input: AssembleInput): AeroResult {
  const { config, prepared, raw, rawReference } = input;
  const { metrics, flow } = prepared;

  const cdOffset = config.reference.cd - rawReference.cd;
  const clOffset = config.reference.cl - rawReference.cl;
  const cd = raw.cd + cdOffset;
  const cl = raw.cl + clOffset;
  const clFront = raw.clFront + clOffset * MODEL.liftDistribution.bodyBase;

  for (const value of [cd, cl, raw.cs, raw.cmYaw, metrics.frontalArea]) {
    if (!Number.isFinite(value)) {
      throw new SimulationError("INVALID_RESULT", "The model produced a non-finite coefficient for this configuration.");
    }
  }
  if (cd <= 0) {
    throw new SimulationError(
      "INVALID_RESULT",
      `The model produced a non-physical drag coefficient (Cd = ${cd.toFixed(3)}); the geometry is outside the model's valid range.`,
    );
  }

  const u = input.uncertaintyModel;
  const uncertainty = {
    cd: Math.hypot(u.cdRelative * cd, u.cdDelta * (raw.cd - rawReference.cd)),
    cl: Math.hypot(u.clAbsolute, u.clDelta * (raw.cl - rawReference.cl)),
  };

  const q = dynamicPressure(flow.density, flow.speed);
  const area = metrics.frontalArea;
  const lift = coefficientForce(q, cl, area);

  const drag: BreakdownItem[] = [
    ...raw.drag.map(({ id, label, value }) => ({ id, label, value })),
    { id: "calibration", label: "Reference calibration (unmodelled detail)", value: cdOffset },
  ];
  const liftItems: BreakdownItem[] = [
    ...raw.lift.map(({ id, label, value }) => ({ id, label, value })),
    { id: "calibration", label: "Reference calibration (unmodelled detail)", value: clOffset },
  ];

  const { rearFlow } = raw;
  const rearState = {
    separationFraction: rearFlow.separationFraction,
    effectiveSlantDeg: rearFlow.effectiveSlantDeg,
    separationX: rearFlow.separationX,
    baseArea: rearFlow.baseArea,
    basePressureCoefficient: rearFlow.basePressureCoefficient,
    wakeLength: rearFlow.wakeLength,
    vortexDrag: rearFlow.vortexDrag,
  };

  const warnings = sanityWarnings({
    geometry: config.geometry,
    metrics,
    rearFlow: rearState,
    cd,
    cl,
    referenceCd: config.reference.cd,
    relativeSpeed: flow.speed,
    yawAngleDeg: flow.yawDeg,
  });
  const assumptions = [...input.assumptions];
  if (prepared.shape.sampled) {
    const cell = Math.round(prepared.shape.sampled.dx * 1000);
    warnings.push({
      code: "IMPORTED_GEOMETRY",
      severity: "info",
      message:
        `The body surface is the outer envelope of an imported 3D model, sampled every ${cell} mm. ` +
        "The accuracy of the model itself is unknown; mirrors, panel gaps, intakes and the underbody are not resolved.",
    });
    assumptions.push(
      `Body surface: outer envelope of an imported 3D model (${cell} mm samples). Frontal area and the solver's solid come from it; ` +
        "the empirical corrections use parameters fitted to it. The reference shape is the generic class.",
    );
  }

  return {
    mode: input.mode,
    source: input.source,
    provenance: input.provenance,
    coefficients: {
      cd,
      cl,
      clFront,
      clRear: cl - clFront,
      cs: raw.cs,
      cmYaw: raw.cmYaw,
      cdFriction: raw.cdFriction,
      referenceSpeed: flow.speed,
      frontalArea: area,
    },
    uncertainty,
    forces: {
      dynamicPressure: q,
      drag: coefficientForce(q, cd, area),
      lift,
      downforce: -lift,
      side: coefficientForce(q, raw.cs, area),
      yawMoment: coefficientForce(q, raw.cmYaw, area) * config.geometry.wheelbase,
    },
    wind: { relativeSpeed: flow.speed, yawAngleDeg: flow.yawDeg },
    air: {
      density: flow.density,
      viscosity: flow.viscosity,
      reynolds: reynoldsNumber(flow.density, flow.speed, metrics.length, flow.viscosity),
    },
    breakdown: { drag, lift: liftItems },
    calibration: { cdRaw: raw.cd, clRaw: raw.cl, cdOffset, clOffset },
    rearFlow: rearState,
    metrics,
    warnings,
    assumptions,
    solver: input.solver,
  };
}
