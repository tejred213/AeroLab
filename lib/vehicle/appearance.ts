/**
 * How a vehicle is dressed in the 3D view: paint, glazing layout, lights, grille
 * and wheels. Appearance only. Nothing here is read by any aerodynamic model;
 * the flow and the forces are computed for the smooth body and plain wheels that
 * the 31 geometry parameters describe.
 *
 * The choices per production car are generic styling cues (door count, the kind
 * of headlight, a typical colour), not a reproduction of the manufacturer's design.
 */
import type { GeometryParams, VehicleDefinition } from "@/lib/types";

export type RimStyle = "five" | "multi" | "aero" | "offroad";
export type HeadlightStyle = "slim" | "block" | "round";
export type TailLightStyle = "split" | "bar" | "upright";
export type GrilleStyle = "none" | "slot" | "wide" | "kidney" | "upright";
export type RoofStyle = "paint" | "glass" | "black";
export type BodyType = "sedan" | "fastback" | "hatchback" | "suv" | "coupe";

export interface CarAppearance {
  bodyType: BodyType;
  /** Paint colour (sRGB hex) and how metallic it is, 0 (solid colour) to 1. */
  paint: string;
  metallic: number;
  doors: 2 | 4;
  /** A fixed side window behind the last door (estates, off-roaders, some coupés). */
  quarterWindow: boolean;
  roof: RoofStyle;
  headlights: HeadlightStyle;
  tailLights: TailLightStyle;
  grille: GrilleStyle;
  /** Unpainted plastic along the sills and around the wheel arches. */
  cladding: boolean;
  rim: RimStyle;
  rimColor: string;
  /** Rim diameter as a fraction of the tyre's outer diameter. */
  rimRatio: number;
  /** Brake caliper colour, or null for plain calipers. */
  caliper: string | null;
  exhausts: 0 | 2 | 4;
}

/** Rim diameter in metres from a tyre size such as "235/45 R18" (the first size, when front and rear differ). */
export function rimDiameterOf(tyres: string): number | null {
  const match = /R\s*(\d{2})/.exec(tyres);
  if (!match) return null;
  const inches = Number(match[1]);
  return inches >= 12 && inches <= 24 ? inches * 0.0254 : null;
}

/** Body type read from the shape itself, for vehicles without a styling entry. */
export function bodyTypeOf(geometry: GeometryParams): BodyType {
  const height = geometry.roofHeight + geometry.rideHeight;
  if (geometry.rearWindowAngle >= 40) return height > 1.58 ? "suv" : "hatchback";
  if (geometry.rearDeckLength >= 0.4) return "sedan";
  return height < 1.32 ? "coupe" : "fastback";
}

const BASE: Record<BodyType, Omit<CarAppearance, "bodyType" | "paint" | "metallic">> = {
  sedan: { doors: 4, quarterWindow: false, roof: "paint", headlights: "block", tailLights: "split", grille: "slot", cladding: false, rim: "multi", rimColor: "#b9bec4", rimRatio: 0.66, caliper: null, exhausts: 2 },
  fastback: { doors: 4, quarterWindow: false, roof: "paint", headlights: "slim", tailLights: "split", grille: "slot", cladding: false, rim: "five", rimColor: "#b9bec4", rimRatio: 0.67, caliper: null, exhausts: 2 },
  hatchback: { doors: 4, quarterWindow: false, roof: "paint", headlights: "block", tailLights: "split", grille: "slot", cladding: false, rim: "five", rimColor: "#b9bec4", rimRatio: 0.65, caliper: null, exhausts: 2 },
  suv: { doors: 4, quarterWindow: true, roof: "paint", headlights: "block", tailLights: "split", grille: "wide", cladding: true, rim: "five", rimColor: "#8d949c", rimRatio: 0.62, caliper: null, exhausts: 2 },
  coupe: { doors: 2, quarterWindow: false, roof: "paint", headlights: "slim", tailLights: "split", grille: "none", cladding: false, rim: "five", rimColor: "#2a2d31", rimRatio: 0.7, caliper: "#c8102e", exhausts: 4 },
};

type Styling = Partial<CarAppearance> & Pick<CarAppearance, "paint" | "metallic">;

/** Styling by vehicle id. Colours are ordinary paint colours, chosen to tell the cars apart. */
const STYLING: Record<string, Styling> = {
  // Generic classes.
  hatchback: { bodyType: "hatchback", paint: "#2f5f9e", metallic: 0.45 },
  sedan: { bodyType: "sedan", paint: "#aab1b9", metallic: 0.6 },
  "sports-coupe": { bodyType: "coupe", paint: "#b01f24", metallic: 0.25, quarterWindow: true },
  suv: { bodyType: "suv", paint: "#44524a", metallic: 0.45 },
  fastback: { bodyType: "fastback", paint: "#5d6670", metallic: 0.6 },
  "generic-ev": { bodyType: "fastback", paint: "#dfe3e6", metallic: 0.3, grille: "none", rim: "aero", roof: "glass", exhausts: 0 },

  // Production-car look-alikes.
  "mercedes-benz-eqs-450": { bodyType: "fastback", paint: "#aeb4ba", metallic: 0.65, grille: "none", headlights: "slim", tailLights: "bar", rim: "aero", roof: "glass", exhausts: 0 },
  "lucid-air-pure": { bodyType: "sedan", paint: "#d9d6cf", metallic: 0.45, grille: "none", headlights: "slim", tailLights: "bar", rim: "aero", roof: "glass", exhausts: 0 },
  "hyundai-ioniq-6": { bodyType: "fastback", paint: "#3d6f8f", metallic: 0.5, grille: "none", headlights: "slim", tailLights: "bar", rim: "aero", exhausts: 0 },
  "tesla-model-3": { bodyType: "sedan", paint: "#a51722", metallic: 0.4, grille: "none", headlights: "slim", tailLights: "split", rim: "aero", roof: "glass", exhausts: 0 },
  "tesla-model-s": { bodyType: "fastback", paint: "#1d3a66", metallic: 0.55, grille: "none", headlights: "slim", tailLights: "split", rim: "multi", rimColor: "#3a3e44", roof: "glass", exhausts: 0 },
  "porsche-taycan-turbo": { bodyType: "fastback", paint: "#7fa7b8", metallic: 0.55, grille: "none", headlights: "block", tailLights: "bar", rim: "five", rimColor: "#c3c8ce", caliper: "#e8e8e8", roof: "glass", exhausts: 0 },
  "toyota-prius-xw50": { bodyType: "fastback", paint: "#c9ccd0", metallic: 0.5, grille: "slot", headlights: "slim", tailLights: "upright", rim: "aero", exhausts: 0 },
  "volkswagen-golf-8": { bodyType: "hatchback", paint: "#6b7682", metallic: 0.55, grille: "slot", headlights: "slim", tailLights: "split", rim: "five" },
  "mercedes-benz-cla-200": { bodyType: "fastback", paint: "#e3e5e7", metallic: 0.35, grille: "wide", headlights: "slim", tailLights: "split", rim: "multi" },
  "audi-a4-b9": { bodyType: "sedan", paint: "#1f3f73", metallic: 0.55, grille: "wide", headlights: "block", tailLights: "split", rim: "five" },
  "bmw-320d-g20": { bodyType: "sedan", paint: "#2f6fb3", metallic: 0.5, grille: "kidney", headlights: "block", tailLights: "split", rim: "multi" },
  "porsche-911-carrera-992": { bodyType: "coupe", paint: "#e8b90f", metallic: 0.1, grille: "none", headlights: "round", tailLights: "bar", quarterWindow: true, rim: "five", rimColor: "#c3c8ce", caliper: "#111111", exhausts: 2 },
  "chevrolet-corvette-c8": { bodyType: "coupe", paint: "#c4161c", metallic: 0.2, grille: "none", headlights: "slim", tailLights: "split", rim: "five", rimColor: "#22252a", caliper: "#f1c40f", exhausts: 4 },
  "mazda-mx-5-nd": { bodyType: "coupe", paint: "#8f1420", metallic: 0.55, grille: "wide", headlights: "slim", tailLights: "split", roof: "black", rim: "multi", rimColor: "#3a3e44", caliper: null, exhausts: 2 },
  "mercedes-benz-g-500": { bodyType: "suv", paint: "#15171a", metallic: 0.5, grille: "upright", headlights: "round", tailLights: "upright", cladding: false, rim: "five", rimColor: "#b9bec4", exhausts: 2 },
  "jeep-wrangler-jl": { bodyType: "suv", paint: "#b3231d", metallic: 0.1, grille: "upright", headlights: "round", tailLights: "upright", roof: "black", rim: "offroad", rimColor: "#1c1e21", exhausts: 0 },
  "land-rover-defender-110": { bodyType: "suv", paint: "#6b7461", metallic: 0.3, grille: "slot", headlights: "round", tailLights: "upright", roof: "paint", rim: "offroad", rimColor: "#d9dcdf", exhausts: 0 },
};

/** Paint for vehicles without a styling entry (custom vehicles): a neutral silver. */
const NEUTRAL: Styling = { paint: "#9aa5b1", metallic: 0.55 };

/**
 * The appearance of a vehicle. `geometry` is the geometry being drawn, so a class
 * that has been reshaped in the editor is dressed for the shape it has now.
 */
export function appearanceFor(vehicle: VehicleDefinition, geometry: GeometryParams = vehicle.geometry): CarAppearance {
  const styling = STYLING[vehicle.id] ?? NEUTRAL;
  const bodyType = STYLING[vehicle.id] ? (styling.bodyType ?? bodyTypeOf(vehicle.geometry)) : bodyTypeOf(geometry);
  const look: CarAppearance = { ...BASE[bodyType], ...styling, bodyType };
  // The real rim size, when the car's tyre size is known.
  const rim = vehicle.realCar ? rimDiameterOf(vehicle.realCar.published.tyres) : null;
  if (rim) look.rimRatio = Math.min(Math.max((rim + 0.02) / vehicle.geometry.wheelDiameter, 0.45), 0.85);
  return look;
}

/** True when a vehicle id has its own styling entry (used by tests to keep the table complete). */
export function hasStyling(id: string): boolean {
  return id in STYLING;
}
