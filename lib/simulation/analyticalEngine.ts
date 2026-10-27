import type { AeroResult, SimulationConfig } from "@/lib/types";
import { MODEL } from "@/lib/physics/model";
import { analyticalRaw } from "@/lib/physics/aeroAnalytical";
import { assembleResult, type PreparedCase, prepareCase } from "@/lib/simulation/assemble";

export const ANALYTICAL_PROVENANCE =
  "Mode A · Analytical — semi-empirical component build-up (closed-form correlations). No flow field is solved.";

export const ANALYTICAL_ASSUMPTIONS = [
  "Steady, incompressible airflow at constant air density.",
  "Coefficients come from closed-form correlations, not from a flow solution.",
  "Rear separation is a smooth empirical function of the effective rear slope (the real transition is abrupt).",
  "Base pressure, trailing-vortex drag and underbody suction use fixed empirical constants.",
  "Rear wing treated with finite-wing (lifting-line) theory in a reduced dynamic-pressure onset flow.",
  "Simplified wheel aerodynamics: exposed-tyre and wheelhouse drag correlations; no wheel rotation effects.",
  "Simplified ground interaction: ride-height dependence via a Venturi-type correlation.",
  "Rigid vehicle body; no thermal, cooling-flow or aeroelastic effects.",
  "Results are anchored to an approximate class reference and are most reliable as differences between configurations.",
];

/** Mode A engine: analytical component build-up, calibrated to the class reference. */
export function runAnalytical(
  config: SimulationConfig,
  source: "browser" | "backend" = "browser",
  prepared: PreparedCase = prepareCase(config),
): AeroResult {
  const raw = analyticalRaw(prepared.shape, prepared.metrics, prepared.flow);
  const rawReference = analyticalRaw(prepared.referenceShape, prepared.referenceMetrics, prepared.calibrationFlow);
  return assembleResult({
    config,
    prepared,
    raw,
    rawReference,
    mode: "analytical",
    source,
    provenance: ANALYTICAL_PROVENANCE,
    uncertaintyModel: MODEL.uncertainty.analytical,
    assumptions: ANALYTICAL_ASSUMPTIONS,
  });
}
