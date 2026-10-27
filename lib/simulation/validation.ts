/**
 * Comparison of the models with published drag coefficients of production cars.
 *
 * Each production car in the library is a parametric look-alike anchored to a
 * generic class: its coefficients are the class reference plus the modelled
 * effect of its shape. The car's own published figure plays no part in that
 * prediction, so the difference between the two is a real test of the model.
 *
 * What the test can and cannot show: the look-alike is a simplified shape whose
 * unpublished proportions are estimates, and a published figure is the
 * manufacturer's own, quoted for a favourable configuration. An error here is
 * the error of "shape model + look-alike", not of the shape model alone.
 */
import { MODEL } from "@/lib/physics/model";
import { STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import { makeConfig } from "@/lib/simulation/config";
import type { AeroResult, Fidelity, SimulationConfig, SimulationMode, VehicleDefinition } from "@/lib/types";

export interface ValidationRow {
  id: string;
  name: string;
  anchorClassName: string;
  /** Reference drag coefficient of the anchor class: the prediction a model with no shape effect would make. */
  anchorCd: number;
  /** Published drag coefficient; null when no figure could be verified. */
  publishedCd: number | null;
  cdNote: string;
  predictedCd: number;
  /** One-sigma uncertainty the model states for its own prediction. */
  uncertainty: number;
  /** Predicted minus published. */
  error: number | null;
  /** Anchor-class reference minus published. */
  baselineError: number | null;
  publishedArea: number | null;
  computedArea: number;
  /** (computed − published) / published frontal area: how well the look-alike matches the car's silhouette. */
  areaError: number | null;
  mode: SimulationMode;
  warnings: string[];
}

export interface ValidationSummary {
  /** Cars with a published drag coefficient. */
  count: number;
  /** Mean absolute error of the model, in Cd. */
  meanAbsError: number;
  /** Mean absolute error of using the class reference alone. */
  baselineMeanAbsError: number;
  /** 1 − model error / baseline error. Positive: the shape model does better than the class reference alone. */
  skill: number;
  /** Mean signed error: positive when the model predicts too much drag on average. */
  bias: number;
  rootMeanSquareError: number;
  largest: { name: string; error: number };
  /** Cars whose published figure lies within one and two stated sigmas of the prediction. */
  withinOneSigma: number;
  withinTwoSigma: number;
  /** Spearman rank correlation between predicted and published: does the model order the cars correctly? */
  rankCorrelation: number;
  /** Mean absolute frontal-area error of the look-alikes that have a published area; null if none do. */
  meanAbsAreaError: number | null;
  areaCount: number;
}

/** The simulation used for the comparison: the car as defined, in still standard air at the calibration speed. */
export function validationConfig(vehicle: VehicleDefinition, mode: SimulationMode, fidelity: Fidelity = "coarse"): SimulationConfig {
  return makeConfig(vehicle, vehicle.geometry, STANDARD_ENVIRONMENT, MODEL.calibration.speed, mode, fidelity);
}

export function validationRow(vehicle: VehicleDefinition, aero: AeroResult): ValidationRow {
  if (!vehicle.realCar) throw new Error(`"${vehicle.id}" is not a production-car look-alike`);
  const { published, anchorClassName } = vehicle.realCar;
  const predictedCd = aero.coefficients.cd;
  const computedArea = aero.coefficients.frontalArea;
  return {
    id: vehicle.id,
    name: vehicle.name,
    anchorClassName,
    anchorCd: vehicle.reference.cd,
    publishedCd: published.cd,
    cdNote: published.cdNote,
    predictedCd,
    uncertainty: aero.uncertainty.cd,
    error: published.cd === null ? null : predictedCd - published.cd,
    baselineError: published.cd === null ? null : vehicle.reference.cd - published.cd,
    publishedArea: published.frontalArea,
    computedArea,
    areaError: published.frontalArea === null ? null : (computedArea - published.frontalArea) / published.frontalArea,
    mode: aero.mode,
    warnings: aero.warnings.filter((warning) => warning.severity === "warning").map((warning) => warning.code),
  };
}

/** Average ranks (1-based); tied values share the mean of the ranks they span. */
function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end++;
    const rank = (start + end) / 2 + 1;
    for (let i = start; i <= end; i++) result[order[i].index] = rank;
    start = end + 1;
  }
  return result;
}

/** Spearman rank correlation coefficient; NaN when either series is constant or shorter than two. */
export function rankCorrelation(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN;
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (a.length + 1) / 2;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    covariance += (ra[i] - mean) * (rb[i] - mean);
    varianceA += (ra[i] - mean) ** 2;
    varianceB += (rb[i] - mean) ** 2;
  }
  return varianceA > 0 && varianceB > 0 ? covariance / Math.sqrt(varianceA * varianceB) : Number.NaN;
}

/** Error statistics over the cars that have a published drag coefficient; null when there are none. */
export function summarizeValidation(rows: ValidationRow[]): ValidationSummary | null {
  const scored = rows.filter(
    (row): row is ValidationRow & { publishedCd: number; error: number; baselineError: number } => row.error !== null,
  );
  if (scored.length === 0) return null;
  const count = scored.length;
  const meanAbsError = scored.reduce((sum, row) => sum + Math.abs(row.error), 0) / count;
  const baselineMeanAbsError = scored.reduce((sum, row) => sum + Math.abs(row.baselineError), 0) / count;
  const largest = scored.reduce((worst, row) => (Math.abs(row.error) > Math.abs(worst.error) ? row : worst), scored[0]);
  const withArea = rows.filter((row): row is ValidationRow & { areaError: number } => row.areaError !== null);
  return {
    count,
    meanAbsError,
    baselineMeanAbsError,
    skill: baselineMeanAbsError > 0 ? 1 - meanAbsError / baselineMeanAbsError : Number.NaN,
    bias: scored.reduce((sum, row) => sum + row.error, 0) / count,
    rootMeanSquareError: Math.sqrt(scored.reduce((sum, row) => sum + row.error ** 2, 0) / count),
    largest: { name: largest.name, error: largest.error },
    withinOneSigma: scored.filter((row) => Math.abs(row.error) <= row.uncertainty).length,
    withinTwoSigma: scored.filter((row) => Math.abs(row.error) <= 2 * row.uncertainty).length,
    rankCorrelation: rankCorrelation(
      scored.map((row) => row.predictedCd),
      scored.map((row) => row.publishedCd),
    ),
    meanAbsAreaError: withArea.length > 0 ? withArea.reduce((sum, row) => sum + Math.abs(row.areaError), 0) / withArea.length : null,
    areaCount: withArea.length,
  };
}
