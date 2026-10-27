/**
 * Where the visible details of a car sit on the parametric body: glazing and
 * pillars, door cuts, lights, grille, wheel arches and mirrors.
 *
 * Everything is derived from the body shape, so the details follow the geometry
 * sliders. Four of them are drawn from parameters the aerodynamic models use,
 * so the picture shows what is computed: the door mirrors (mirrorWidth, the
 * same box the solver and the frontal area use), how open the rims are
 * (rimOpenness), the size of the grille and intakes (grilleOpening) and the
 * wheel-arch opening (wheelExposure). The rest (glass, door cuts, lights) has no
 * effect these models can resolve and is appearance only. Lengths in metres;
 * heights in the body frame (above the floor plane) unless stated.
 */
import { type BodyShape, lowerZ, mirrorGeometry, planHalfWidth, upperZ, wheelGeometry } from "@/lib/geometry/profile";
import { DEG_TO_RAD, MODEL } from "@/lib/physics/model";
import type { CarAppearance } from "@/lib/vehicle/appearance";

const P = MODEL.profile;

export interface TrimLayout {
  length: number;
  halfWidth: number;
  ride: number;
  belt: number;
  roofEdge: number;
  /** Height over which the cabin narrows from the belt to the roof edge. */
  greenhouse: number;
  cabinRatio: number;
  cowl: number;
  deckStart: number;
  deckLength: number;
  /** Station halfway along the roof: what slopes ahead of it is the windscreen, behind it the rear window. */
  midRoof: number;
  /** Windscreen and rear window, as ranges of the upper-profile height they cover. */
  screenLow: number;
  backLow: number;
  slopeHigh: number;
  /** Glass roof panel, as a range of x; null without one. */
  roofGlass: [number, number] | null;

  /** Side glass: a four-sided opening between glassBottom and glassTop. */
  sideGlass: {
    bottom: number;
    top: number;
    /** x of the front edge at the bottom and at the top, and likewise for the rear edge. */
    front: [number, number];
    rear: [number, number];
    /** Pillars that divide it: centre x and half-width. */
    pillars: [number, number][];
  } | null;

  /** Door cuts (x), from the sill up to the belt. */
  doorLines: number[];
  sill: number;
  sillRange: [number, number];
  /** Door handles: x of the centre; all at handleZ. */
  handles: number[];
  handleZ: number;

  arch: {
    /** Stations of the front and rear axle. */
    x: [number, number];
    /** Height of the wheel centre in the body frame. */
    z: number;
    radius: number;
    lip: number;
    /** The arch is cut only outboard of this |y|, so the floor stays closed between the wheels. */
    innerY: number;
  };

  head: { xMax: number; z: number; halfHeight: number; innerY: number; round: { x: number; y: number; z: number; radius: number } | null };
  tail: { xMin: number; z: number; halfHeight: number; innerY: number };
  intake: { low: number; high: number; halfWidth: number };
  /** Upper grille: height range, outer and inner |y| (inner > 0 splits it in two). */
  grille: { low: number; high: number; outerY: number; innerY: number; slats: boolean } | null;
  plateZ: number;
  exhaust: { y: number; z: number; radius: number; pairs: number } | null;

  /** Door mirror housing: centre (absolute z), and its size along the car, across it and in height. Null without mirrors. */
  mirror: { x: number; y: number; z: number; depth: number; width: number; height: number } | null;
  /** 0 = closed covers, 1 = thin open spokes (the rimOpenness parameter). */
  rimOpenness: number;
  wheels: { x: number; y: number; z: number; radius: number; width: number; rimRadius: number }[];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Station on the nose at which the upper surface reaches a height (the surface rises monotonically there). */
function stationAtHeight(shape: BodyShape, height: number): number {
  let low = 0;
  let high = Math.min(0.8, shape.xCowl);
  for (let i = 0; i < 24; i++) {
    const middle = 0.5 * (low + high);
    if (upperZ(shape, middle) < height) low = middle;
    else high = middle;
  }
  return 0.5 * (low + high);
}

/** Horizontal thickness of the rearmost pillar at belt level, by body type. */
const REAR_PILLAR = { sedan: 0.32, fastback: 0.3, hatchback: 0.26, suv: 0.16, coupe: 0.24 } as const;

export function buildTrimLayout(shape: BodyShape, look: CarAppearance): TrimLayout {
  const { params, length } = shape;
  const halfWidth = params.width / 2;
  const ride = params.rideHeight;
  const belt = params.beltHeight;
  const roofEdge = shape.roofEdgeHeight;
  const wheels = wheelGeometry(shape);
  const wheelRadius = params.wheelDiameter / 2;

  // --- Wheel arches ---
  // The opening is a little larger than the tyre, but always stays below the top of the wing above it.
  const fenderRoom = Math.min(upperZ(shape, shape.frontAxleX), upperZ(shape, shape.rearAxleX)) - (wheelRadius - ride) - 0.06;
  // The gap follows the wheel-exposure parameter: shrouded wheels sit in a tight arch, exposed ones in an open one.
  const archRadius = Math.max(Math.min(wheelRadius + 0.03 + 0.05 * params.wheelExposure, fenderRoom), wheelRadius + 0.012);
  const arch = {
    x: [shape.frontAxleX, shape.rearAxleX] as [number, number],
    z: wheelRadius - ride,
    radius: archRadius,
    lip: look.cladding ? 0.04 : 0.012,
    innerY: shape.wheelCentreY - params.tireWidth / 2 - 0.05,
  };

  // --- Side glass ---
  const cotFront = 1 / Math.tan(params.windshieldAngle * DEG_TO_RAD);
  const cotRear = 1 / Math.tan(params.rearWindowAngle * DEG_TO_RAD);
  const bottom = belt + 0.035;
  const top = roofEdge - 0.075;
  let sideGlass: TrimLayout["sideGlass"] = null;
  if (top - bottom > 0.1) {
    // Front edge: parallel to the windscreen, one A-pillar behind it, and never ahead of the cowl.
    const pillarA = 0.085;
    const frontAt = (z: number) => shape.xRoofStart - (roofEdge - z) * cotFront + pillarA;
    const front: [number, number] = [Math.max(frontAt(bottom), shape.xCowl + 0.1), Math.max(frontAt(top), shape.xCowl + 0.1)];
    // Rear edge: follows the rear window, with a pillar that is thicker at the belt than at the roof,
    // and stops short of the boot lid on a car that has one.
    const rearAt = (z: number) => shape.xRoofEnd + (roofEdge - z) * cotRear;
    const limit = params.rearDeckLength > 0.05 ? shape.xDeckStart - 0.1 : length - 0.1;
    const rear: [number, number] = [
      Math.min(rearAt(bottom) - REAR_PILLAR[look.bodyType], limit),
      Math.min(rearAt(top) - 0.12, limit),
    ];
    if (rear[0] - front[0] > 0.5 && rear[1] - front[1] > 0.2) {
      const span = rear[0] - front[0];
      const pillars: [number, number][] = [];
      if (look.doors === 4) pillars.push([front[0] + (look.quarterWindow ? 0.38 : 0.5) * span, 0.04]);
      if (look.quarterWindow) pillars.push([front[0] + (look.doors === 4 ? 0.76 : 0.66) * span, look.doors === 4 ? 0.045 : 0.028]);
      sideGlass = { bottom, top, front, rear, pillars };
    }
  }

  // --- Doors ---
  const doorFront = clamp(
    (sideGlass ? sideGlass.front[0] : shape.xCowl + 0.1) - 0.03,
    shape.frontAxleX + archRadius + 0.05,
    shape.frontAxleX + archRadius + 0.14,
  );
  const doorLines = [doorFront];
  const handles: number[] = [];
  if (look.doors === 4) {
    const middle = sideGlass?.pillars[0]?.[0] ?? shape.frontAxleX + 0.5 * params.wheelbase;
    const rearDoor = Math.max(shape.rearAxleX - 0.55 * archRadius, middle + 0.5);
    doorLines.push(middle, rearDoor);
    handles.push(middle - 0.17, rearDoor - 0.2);
  } else {
    const rearEdge = Math.min(doorFront + clamp(0.42 * params.wheelbase, 1, 1.25), shape.rearAxleX - archRadius - 0.05);
    doorLines.push(rearEdge);
    handles.push(rearEdge - 0.17);
  }

  // --- Lights ---
  const nose = params.frontBumperHeight;
  const round = look.headlights === "round";
  const head = {
    xMax: round ? 0.6 : 0.52,
    z: nose - 0.02,
    halfHeight: look.headlights === "block" ? 0.06 : 0.036,
    innerY: 0.42 * halfWidth,
    round: round ? { x: stationAtHeight(shape, nose - 0.06), y: 0.62 * halfWidth, z: nose - 0.06, radius: clamp(0.11 * halfWidth, 0.08, 0.105) } : null,
  };
  const tailTop = shape.tailHeight - 0.04;
  const tail =
    look.tailLights === "bar"
      ? { xMin: length - 0.2, z: tailTop - 0.035, halfHeight: 0.026, innerY: 0 }
      : look.tailLights === "upright"
        ? { xMin: length - 0.05, z: tailTop - 0.16, halfHeight: 0.11, innerY: 0.76 * halfWidth }
        : { xMin: length - 0.22, z: tailTop - 0.055, halfHeight: 0.05, innerY: 0.44 * halfWidth };

  // --- Grille and intakes ---
  const stagnation = shape.stagnationHeight;
  // The openings are drawn in proportion to the cooling intake area that the drag model uses: a sealed front
  // shows none, a small intake only the lower slot, and the upper grille appears once there is area for it.
  const opening = Math.sqrt(Math.min(params.grilleOpening / 0.045, 2));
  const intake = {
    low: 0.07,
    high: params.grilleOpening > 0.002 ? Math.min(0.21, stagnation - 0.02) : 0.07,
    halfWidth: Math.min(0.5 * opening, 0.72) * halfWidth,
  };
  const wide = Math.min(opening, 1.25);
  let grille: TrimLayout["grille"] = null;
  if (params.grilleOpening >= 0.028) {
    if (look.grille === "slot") grille = { low: stagnation + 0.035, high: nose - 0.1, outerY: 0.36 * wide * halfWidth, innerY: 0, slats: false };
    if (look.grille === "wide") grille = { low: stagnation - 0.02, high: nose - 0.08, outerY: 0.42 * wide * halfWidth, innerY: 0, slats: false };
    if (look.grille === "kidney") grille = { low: stagnation + 0.03, high: nose - 0.09, outerY: 0.3 * wide * halfWidth, innerY: 0.035, slats: false };
    if (look.grille === "upright") grille = { low: nose - 0.24, high: nose + 0.01, outerY: 0.4 * Math.min(wide, 1.1) * halfWidth, innerY: 0, slats: true };
  }
  if (grille && grille.high - grille.low < 0.04) grille = null;

  // --- Mirrors: the same housing the solver and the frontal area use ---
  const housing = mirrorGeometry(shape);
  const mirror = housing.present
    ? {
        x: 0.5 * (housing.x0 + housing.x1),
        y: housing.y1 - params.mirrorWidth,
        z: ride + 0.5 * (housing.z0 + housing.z1),
        depth: housing.x1 - housing.x0,
        width: params.mirrorWidth,
        height: housing.z1 - housing.z0,
      }
    : null;

  const rimRadius = Math.min(look.rimRatio * wheelRadius, wheelRadius - 0.035);
  const tailLower = shape.diffuserExitHeight;

  return {
    length,
    halfWidth,
    ride,
    belt,
    roofEdge,
    greenhouse: Math.max(roofEdge - belt, 0.01),
    cabinRatio: params.cabinWidthRatio,
    cowl: shape.xCowl,
    deckStart: shape.xDeckStart,
    deckLength: params.rearDeckLength,
    midRoof: 0.5 * (shape.xRoofStart + shape.xRoofEnd),
    screenLow: params.hoodHeight + 0.05,
    backLow: shape.deckHeight + 0.05,
    slopeHigh: roofEdge - 0.03,
    roofGlass: look.roof === "glass" && shape.xRoofEnd - shape.xRoofStart > 0.5 ? [shape.xRoofStart + 0.12, shape.xRoofEnd - 0.1] : null,
    sideGlass,
    doorLines,
    sill: 0.105,
    sillRange: [shape.frontAxleX + archRadius, shape.rearAxleX - archRadius],
    handles,
    handleZ: belt - 0.065,
    arch,
    head,
    tail,
    intake,
    grille,
    plateZ: Math.max(0.42 * shape.tailHeight, tailLower + 0.2),
    exhaust: look.exhausts > 0 ? { y: 0.52 * halfWidth, z: tailLower + 0.075, radius: 0.04, pairs: look.exhausts / 2 } : null,
    mirror,
    rimOpenness: params.rimOpenness,
    wheels: wheels.map((wheel) => ({ ...wheel, rimRadius })),
  };
}

/** Upper profile, underbody and plan half-width at the station of every vertex of a body mesh (3 values per vertex). */
export function sectionAttribute(shape: BodyShape, positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  let lastX = Number.NaN;
  let values = [0, 0, 0];
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v];
    if (x !== lastX) {
      lastX = x;
      values = [upperZ(shape, x), lowerZ(shape, x), planHalfWidth(shape, x)];
    }
    out[v] = values[0];
    out[v + 1] = values[1];
    out[v + 2] = values[2];
  }
  return out;
}

/** Radius of the rounded roof edge of the section, used to keep glazing off the shoulders. */
export const TOP_EDGE_RADIUS = P.topEdgeRadius;
