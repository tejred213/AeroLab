/**
 * Core domain types shared by geometry, physics, simulation and UI.
 *
 * Units: everything is SI (m, kg, s, N, Pa, W, K) except angles, which are
 * stored in degrees because they are geometric descriptors edited by the user.
 * Functions convert to radians at the point of use.
 */

/** Parametric description of the vehicle. Mirrors shared/parameters.json. */
export interface GeometryParams {
  wheelbase: number;
  frontOverhang: number;
  rearOverhang: number;
  width: number;
  /** Roof crown above the body floor plane. */
  roofHeight: number;
  beltHeight: number;
  hoodLength: number;
  hoodHeight: number;
  frontBumperHeight: number;
  rearBumperHeight: number;
  windshieldAngle: number;
  rearWindowAngle: number;
  rearDeckLength: number;
  frontTaper: number;
  rearTaper: number;
  cabinWidthRatio: number;
  rideHeight: number;
  minGroundClearance: number;
  floorFlatness: number;
  diffuserAngle: number;
  diffuserLength: number;
  splitterExtension: number;
  spoilerAngle: number;
  spoilerHeight: number;
  spoilerWidth: number;
  wingChord: number;
  wingAngle: number;
  sideSkirtDepth: number;
  wheelDiameter: number;
  tireWidth: number;
  wheelExposure: number;
  /** Lateral span of each door mirror housing, m; 0 = no mirrors. */
  mirrorWidth: number;
  /** 0 = closed wheel covers, 1 = thin open spokes. */
  rimOpenness: number;
  /** Open cooling intake area as a share of the frontal area. */
  grilleOpening: number;
}

export type ParamId = keyof GeometryParams;

export type ParamKind = "length" | "angle" | "ratio";

export interface ParamDefinition {
  id: ParamId;
  label: string;
  group: string;
  kind: ParamKind;
  min: number;
  max: number;
  step: number;
  /** Value given to geometries stored before this parameter existed. */
  default?: number;
  tooltip: string;
}

export interface ParamGroup {
  id: string;
  label: string;
}

export type Drivetrain = "FWD" | "RWD" | "AWD";

/** One point of a user-defined power curve. */
export interface PowerCurvePoint {
  rpm: number;
  powerW: number;
}

export interface IcePowertrain {
  type: "ICE";
  peakPowerW: number;
  peakPowerRpm: number;
  peakTorqueNm: number;
  peakTorqueRpm: number;
  idleRpm: number;
  redlineRpm: number;
  gearRatios: number[];
  finalDrive: number;
  drivetrainEfficiency: number;
  /** Time with no drive force during each gear change, s. */
  shiftTime: number;
  /** Optional user-defined power-vs-engine-speed curve; overrides the simplified curve. */
  powerCurve: PowerCurvePoint[] | null;
}

export interface EvPowertrain {
  type: "EV";
  peakPowerW: number;
  peakTorqueNm: number;
  maxMotorRpm: number;
  /** Single-speed reduction ratio (motor rev per wheel rev). */
  gearRatio: number;
  drivetrainEfficiency: number;
  batteryCapacityJ: number;
}

export type Powertrain = IcePowertrain | EvPowertrain;

/** Chassis properties used by the vehicle-dynamics model. */
export interface VehicleSpec {
  mass: number;
  cgHeight: number;
  /** Static fraction of weight on the front axle, 0..1. */
  weightDistFront: number;
  drivetrain: Drivetrain;
  /** Rolling resistance coefficient. */
  crr: number;
  /** Peak tyre-road friction coefficient. */
  tireMu: number;
}

/**
 * Where the value of one geometry parameter comes from. For a production-car look-alike: a published dimension,
 * derived from published figures, estimated, or the generic class value. For an imported 3D model: measured from
 * the model, or the class value.
 */
export type ParamBasis = "published" | "derived" | "estimated" | "class" | "measured";

/** Published figures of a production car, shown for comparison. The aerodynamic models never read them. */
export interface PublishedCarData {
  /** Published drag coefficient; null when no figure could be verified. */
  cd: number | null;
  /** Who quotes the figure and under which conditions, or why there is none. */
  cdNote: string;
  /** Published frontal area, m²; null when not published. */
  frontalArea: number | null;
  /** Dimensions in m; the length excludes a rear-mounted spare wheel. */
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  /** null when no source gives it (the look-alike's ride height is then an estimate). */
  groundClearance: number | null;
  kerbMass: number;
  tyres: string;
}

/** What makes a library vehicle a look-alike of a production car. */
export interface RealCarInfo {
  years: string;
  bodyStyle: string;
  /** Generic class whose reference coefficients and shape anchor the prediction. */
  anchorClassId: string;
  anchorClassName: string;
  published: PublishedCarData;
  sources: { label: string; url: string }[];
  notes: string[];
  /** Provenance of every geometry parameter. */
  basis: Record<ParamId, ParamBasis>;
}

/** Where an imported 3D model came from; entered by the user and shown wherever the model is used. */
export interface ModelSource {
  title: string;
  author: string;
  url: string;
  licence: string;
}

/** What makes a custom vehicle an imported 3D model. */
export interface ImportedModelInfo {
  /** Key of the stored model files and of the measured envelope. */
  bodyId: string;
  fileName: string;
  triangles: number;
  /** Row-major 4 x 4 matrix from model coordinates to tunnel coordinates with the tyres on z = 0. */
  matrix: number[];
  /** Factor applied to the file's units to reach metres. */
  scale: number;
  /** Names of the parts of the file that were left out (ground planes, shadows, ...). */
  excludedParts: string[];
  /** Sampling resolution of the measured envelope, m. */
  resolution: number;
  /** Ride height of the model as measured, m; the painted model is drawn shifted by any change from it. */
  rideHeight: number;
  /** Dimensions of the model after scaling, m. */
  measured: {
    /** Length of the body the solver uses. */
    length: number;
    width: number;
    height: number;
    silhouetteArea: number;
    wheelsFound: boolean;
    /** Depth of a rear-mounted spare wheel or carrier that is drawn but is not part of that body, m. */
    rearAttachment?: number;
  };
  /** Values of the shape parameters fitted to the model; the envelope applies only while they are unchanged. */
  shapeParams: Partial<Record<ParamId, number>>;
  /** Generic class that anchors the prediction. */
  anchorClassId: string;
  anchorClassName: string;
  /** Library car this model is said to represent, if any (used for published figures only). */
  linkedCarId?: string;
  source: ModelSource;
  /** Provenance of every geometry parameter. */
  basis: Record<ParamId, ParamBasis>;
  importedAt: number;
}

export interface VehicleDefinition extends VehicleSpec {
  id: string;
  name: string;
  description: string;
  /** Approximate class reference coefficients used as the calibration anchor. */
  reference: { cd: number; cl: number };
  geometry: GeometryParams;
  /**
   * Geometry that the reference coefficients belong to, when it is not this vehicle's own geometry.
   * Set for production-car look-alikes, which are anchored to a generic class.
   */
  referenceGeometry?: GeometryParams;
  powertrain: Powertrain;
  /** True for user-created vehicles. */
  custom?: boolean;
  /** Present for look-alikes of production cars. */
  realCar?: RealCarInfo;
  /** Present for vehicles created from an imported 3D model. */
  importedModel?: ImportedModelInfo;
}

export interface Environment {
  /** "direct": use airDensity as given. "computed": derive from T, p and humidity. */
  airDensityMode: "direct" | "computed";
  airDensity: number;
  /** K */
  temperature: number;
  /** Pa */
  pressure: number;
  /** Relative humidity 0..1 */
  humidity: number;
  /** Ambient wind speed, m/s. */
  windSpeed: number;
  /** Ambient wind direction, deg. 0 = pure headwind, +/-90 = pure crosswind. */
  windAngle: number;
  /** Road gradient, deg. Positive = uphill. */
  gradient: number;
}

export type SimulationMode = "analytical" | "reduced-order" | "cfd" | "ml-surrogate";

export type Fidelity = "coarse" | "medium" | "fine";

/** Grid settings a Mode C run may use (the backend enforces the same list): a fine CFD mesh costs too much compute. */
export const CFD_RUN_FIDELITIES: readonly Fidelity[] = ["coarse", "medium"];

/** The grid setting a mode can use: Mode C falls back to medium when fine is asked for. */
export function fidelityFor(mode: SimulationMode, fidelity: Fidelity): Fidelity {
  return mode === "cfd" && !CFD_RUN_FIDELITIES.includes(fidelity) ? "medium" : fidelity;
}

/** Everything that defines one aerodynamic simulation. This is what gets hashed for the cache. */
export interface SimulationConfig {
  /** Vehicle class supplying the reference geometry and reference coefficients. */
  vehicleId: string;
  reference: { cd: number; cl: number };
  referenceGeometry: GeometryParams;
  geometry: GeometryParams;
  environment: Environment;
  /** Vehicle road speed, m/s. */
  speed: number;
  mode: SimulationMode;
  fidelity: Fidelity;
  /**
   * Measured outer envelope of an imported 3D model that replaces the parametric body surface.
   * Present only while the shape parameters still equal the values fitted to that model.
   */
  bodyId?: string;
  /**
   * Mode C on an imported 3D model: the closed, shrink-wrapped surface stored on the backend that is meshed
   * instead of the parametric body, and how it was wrapped.
   */
  cfdSurface?: { id: string; voxel?: number; seal?: number };
}

export interface BreakdownItem {
  id: string;
  label: string;
  value: number;
}

export type WarningSeverity = "info" | "warning" | "error";

export interface SimWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
}

export interface GeometryMetrics {
  length: number;
  overallHeight: number;
  frontalArea: number;
  sideArea: number;
  /** x of the side-area centroid, m from the nose. */
  sideAreaCentroidX: number;
  wettedArea: number;
  /** Lowest point of the sprung body above ground. */
  groundClearance: number;
  roofLength: number;
  trackWidth: number;
  /** Effective rear slope from roof trailing edge to tail edge, deg. */
  effectiveSlantDeg: number;
}

export interface RearFlowState {
  /** 0 = flow attached down to the tail edge, 1 = separated at the roof trailing edge. */
  separationFraction: number;
  effectiveSlantDeg: number;
  /** x of the upper-surface separation line, m from the nose. */
  separationX: number;
  baseArea: number;
  basePressureCoefficient: number;
  /** Length of the wake displacement body behind the tail, m. */
  wakeLength: number;
  vortexDrag: number;
}

export interface AeroCoefficients {
  cd: number;
  cl: number;
  clFront: number;
  clRear: number;
  /** Side-force coefficient (body axis, reference area = frontal area). */
  cs: number;
  /** Yaw-moment coefficient about mid-wheelbase (reference A x wheelbase). */
  cmYaw: number;
  /** Part of cd that scales with skin friction (Reynolds dependent). */
  cdFriction: number;
  /** Speed at which the coefficients were evaluated, m/s. */
  referenceSpeed: number;
  frontalArea: number;
}

export interface AeroForces {
  dynamicPressure: number;
  drag: number;
  /** Positive = upward. */
  lift: number;
  /** Positive = toward the road ( = -lift ). */
  downforce: number;
  side: number;
  yawMoment: number;
}

export interface SolverDiagnostics {
  cells: number;
  fluidCells: number;
  iterations: number;
  residual: number;
  converged: boolean;
  gridSize: [number, number, number];
  blockageRatio: number;
  rawCd: number;
  rawCl: number;
  pressureDragAttached: number;
  basePressureFromField: number;
}

/** What is known about a CFD solver run made by the backend (absent for imported coefficients). */
export interface CfdRunInfo {
  openfoamVersion: string;
  meshSetting: Fidelity;
  /** Cell count reported by checkMesh; null if it could not be read. */
  cells: number | null;
  /** Failed checkMesh checks; null if the report could not be read. */
  meshChecksFailed: number | null;
  prismLayers: number;
  /** Surface cell size on the body, mm: [coarsest, finest]. */
  surfaceCellMm: [number, number];
  /** y+ on the body at the end of the run; null if the solver log has no report. */
  yPlusBody: { min: number; max: number; average: number } | null;
  processors: number;
  iterations: number;
  iterationLimit: number;
  /** True when the solver stopped because every residual target was met. */
  residualTargetsMet: boolean;
  /** Iteration at which the backend stopped the solver because Cd and Cl had settled; null if it ran on. */
  settledAt?: number | null;
  wallTimeS: number;
  caseDir: string;
  /** Present when the case was meshed from the wrapped surface of an imported 3D model. */
  surface?: { id: string; triangles: number; frontalArea: number; area: number; sink: number; voxel: number | null; seal: number | null };
}

export interface SurrogateInfo {
  modelId: string;
  algorithm: string;
  trainingSamples: number;
  sourceMode: SimulationMode;
  validationRmseCd: number;
  validationRmseCl: number;
  validationR2Cd: number;
  validationR2Cl: number;
  inferenceTimeMs: number;
}

export type ResultSource = "browser" | "backend" | "imported";

export interface AeroResult {
  mode: SimulationMode;
  /** Where the numbers came from: computed here, computed by the backend, or read from a user-supplied solver file. */
  source: ResultSource;
  /** Human-readable provenance, shown wherever results are displayed. */
  provenance: string;
  coefficients: AeroCoefficients;
  /** 1-sigma model uncertainty of the coefficients. */
  uncertainty: { cd: number; cl: number };
  forces: AeroForces;
  wind: { relativeSpeed: number; yawAngleDeg: number };
  air: { density: number; viscosity: number; reynolds: number };
  breakdown: { drag: BreakdownItem[]; lift: BreakdownItem[] };
  calibration: { cdRaw: number; clRaw: number; cdOffset: number; clOffset: number };
  rearFlow: RearFlowState;
  metrics: GeometryMetrics;
  warnings: SimWarning[];
  assumptions: string[];
  solver?: SolverDiagnostics;
  surrogate?: SurrogateInfo;
  cfd?: CfdRunInfo;
}

export interface SpeedSample {
  /** m/s */
  speed: number;
  drag: number;
  downforce: number;
  rolling: number;
  grade: number;
  cd: number;
  /** Power needed at the wheels to hold this speed, W. */
  powerRequired: number;
  powerAero: number;
  powerRolling: number;
  powerGrade: number;
  /** Maximum power deliverable at the wheels at this speed, W. */
  powerAvailable: number;
  tractionForce: number;
}

export interface AccelSample {
  time: number;
  speed: number;
  acceleration: number;
  distance: number;
  gear: number;
  tractionLimited: boolean;
}

export type TopSpeedLimit = "power" | "redline" | "motor-rpm" | "none";

export interface PerformanceResult {
  topSpeed: number;
  topSpeedLimit: TopSpeedLimit;
  /** Seconds from rest to each target speed; null when the target is not reached. */
  accelTimes: { target: number; time: number | null }[];
  accelTrace: AccelSample[];
  speedSweep: SpeedSample[];
  tractionLimited: boolean;
  /** Steepest grade that can be held at 30 km/h, deg. */
  maxGradeDeg: number;
  forcesAtSpeed: {
    speed: number;
    drag: number;
    rolling: number;
    grade: number;
    total: number;
    powerRequired: number;
  };
  /** EV only: range at a steady 100 km/h on the configured gradient, m. */
  rangeAt100: number | null;
  assumptions: string[];
}

export interface SimulationResult {
  /** Deterministic hash of the SimulationConfig. */
  hash: string;
  config: SimulationConfig;
  aero: AeroResult;
  durationMs: number;
  /** True when returned from the result cache instead of being recomputed. */
  cached: boolean;
}

export type JobState =
  | "QUEUED"
  | "PREPARING"
  | "MESHING"
  | "SOLVING"
  | "POST_PROCESSING"
  | "COMPLETE"
  | "FAILED";

export interface JobProgress {
  state: JobState;
  /** 0..1 */
  progress: number;
  message: string;
}

export class SimulationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SimulationError";
    this.code = code;
  }
}
