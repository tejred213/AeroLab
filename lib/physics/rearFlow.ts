/**
 * Rear-end flow closure shared by the analytical (Mode A) and reduced-order
 * (Mode B) engines: where the flow separates, how large the base is, and the
 * base pressure acting on it.
 *
 * The trend follows the well-documented behaviour of slanted-back bluff bodies
 * (Ahmed body): for effective slants below about 30 deg the flow stays attached
 * and strong trailing vortices add drag; above it the flow separates at the roof
 * trailing edge and the body behaves like a squareback. The real transition is
 * abrupt and can be bistable; here it is represented by a smooth blend.
 *
 * backend/physics/rear_flow.py mirrors this file.
 */
import type { RearFlowState } from "@/lib/types";
import { MODEL } from "@/lib/physics/model";
import { type BodyShape, planHalfWidth, spoilerGeometry } from "@/lib/geometry/profile";
import { effectiveSlantDeg } from "@/lib/geometry/metrics";

const R = MODEL.rearFlow;

export interface RearFlowDetail extends RearFlowState {
  /** Projected area of the vertical tail face, m^2. */
  tailArea: number;
  /** Rear-window area projected onto the Y-Z plane, m^2. */
  slantArea: number;
  /** Rear-window area projected onto the X-Y plane, m^2. */
  slantPlanArea: number;
  /** Height of the separated base region, m. */
  baseHeight: number;
  /**
   * 0..1 strength of the separation bubble on the rear window: the flow leaves the roof
   * edge because the window itself is steep, but re-attaches before the tail (notchback).
   */
  bubbleFraction: number;
  /** Fraction of the rear window lying in separated flow (wake or bubble). */
  slantSeparated: number;
}

export function computeRearFlow(shape: BodyShape, frontalArea: number): RearFlowDetail {
  const { params, length } = shape;
  const tailWidth = 2 * planHalfWidth(shape, length);
  const roofWidth = (tailWidth * (1 + params.cabinWidthRatio)) / 2;
  const slantHeight = Math.max(shape.roofEdgeHeight - shape.deckHeight, 0);
  const tailFaceHeight = Math.max(shape.tailHeight - shape.diffuserExitHeight, 0);

  const tailArea = R.baseShapeFactor * tailWidth * tailFaceHeight;
  const slantArea = roofWidth * slantHeight;
  const slantPlanArea = roofWidth * Math.max(shape.xDeckStart - shape.xRoofEnd, 0);

  const slant = effectiveSlantDeg(shape);
  const separationFraction = 1 / (1 + Math.exp(-(slant - R.separationCenterDeg) / R.separationWidthDeg));

  // A locally steep rear window separates at the roof edge even when the deck lets the
  // flow re-attach (effective slope still shallow): a closed bubble sits on the window.
  const localSeparation =
    1 / (1 + Math.exp(-(params.rearWindowAngle - R.separationCenterDeg) / R.separationWidthDeg));
  const bubbleFraction = (1 - separationFraction) * localSeparation;
  const slantSeparated = separationFraction + bubbleFraction;

  const baseArea = tailArea + slantSeparated * slantArea;
  const basePressureCoefficient =
    (R.cpBaseAttached + (R.cpBaseSeparated - R.cpBaseAttached) * separationFraction) *
    (1 - R.boatTailRelief * params.rearTaper);

  // Trailing-vortex drag of an attached slanted back; grows toward the critical angle.
  const onset = Math.min(
    Math.max((slant - R.vortexOnsetDeg) / (R.separationCenterDeg - R.vortexOnsetDeg), 0),
    1.2,
  );
  const vortexDrag =
    R.vortexDragCoefficient * (slantArea / frontalArea) * (1 - slantSeparated) * Math.pow(onset, 1.5);

  const spoiler = spoilerGeometry(shape);
  const baseHeight =
    tailFaceHeight +
    separationFraction * slantHeight +
    (1 - separationFraction) * (spoiler.present ? spoiler.rise : 0);

  return {
    separationFraction,
    effectiveSlantDeg: slant,
    separationX: length - separationFraction * (length - shape.xRoofEnd),
    baseArea,
    basePressureCoefficient,
    wakeLength: R.wakeLengthFactor * baseHeight,
    vortexDrag,
    tailArea,
    slantArea,
    slantPlanArea,
    baseHeight,
    bubbleFraction,
    slantSeparated,
  };
}
