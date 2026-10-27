/**
 * Converting the older "specular / glossiness" material description of glTF
 * (KHR_materials_pbrSpecularGlossiness, still what many model sites export) to
 * the metallic / roughness description three.js renders. Pure functions on
 * linear colour values; the formula is the one from the Khronos glTF samples.
 */
export type Rgb = [number, number, number];

/** Specular reflectance of a non-metal. */
const DIELECTRIC = 0.04;
const EPSILON = 1e-6;

function brightness(c: Rgb): number {
  return Math.sqrt(0.299 * c[0] * c[0] + 0.587 * c[1] * c[1] + 0.114 * c[2] * c[2]);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Metalness and base colour that reproduce a diffuse and a specular colour (all linear, 0..1). */
export function specGlossToMetalRough(diffuse: Rgb, specular: Rgb): { metalness: number; baseColor: Rgb } {
  const strength = Math.max(specular[0], specular[1], specular[2]);
  const oneMinus = 1 - strength;
  const specularBrightness = brightness(specular);
  let metalness = 0;
  if (specularBrightness >= DIELECTRIC) {
    const a = DIELECTRIC;
    const b = (brightness(diffuse) * oneMinus) / (1 - DIELECTRIC) + specularBrightness - 2 * DIELECTRIC;
    const c = DIELECTRIC - specularBrightness;
    metalness = clamp01((-b + Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a));
  }
  const fromDiffuse = oneMinus / (1 - DIELECTRIC) / Math.max(1 - metalness, EPSILON);
  const blend = metalness * metalness;
  const baseColor = [0, 1, 2].map((k) => {
    const dielectric = diffuse[k] * fromDiffuse;
    const metal = (specular[k] - DIELECTRIC * (1 - metalness)) / Math.max(metalness, EPSILON);
    return clamp01(dielectric + (metal - dielectric) * blend);
  }) as Rgb;
  return { metalness, baseColor };
}

/** sRGB-encoded byte to linear value, as a table. */
export const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
});

export function linearToSrgbByte(value: number): number {
  const v = clamp01(value);
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}

/** Where a model file names its own source, as sites such as Sketchfab write it into glTF "asset.extras". */
export interface ModelCredit {
  title: string;
  author: string;
  url: string;
  licence: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 300) : "";
}

/** "Name (https://...)" is how the author and the licence are written; only the name is kept. */
function withoutLink(value: string): string {
  return value.replace(/\s*\(https?:\/\/[^)]*\)\s*$/, "").trim();
}

export function creditFromAsset(asset: unknown): ModelCredit | null {
  const extras = (asset as { extras?: Record<string, unknown> } | null)?.extras;
  if (!extras || typeof extras !== "object") return null;
  const source = text(extras.source);
  const credit: ModelCredit = {
    title: text(extras.title),
    author: withoutLink(text(extras.author)),
    url: /^https?:\/\//.test(source) ? source : "",
    licence: withoutLink(text(extras.license)),
  };
  return credit.title || credit.author || credit.url || credit.licence ? credit : null;
}
