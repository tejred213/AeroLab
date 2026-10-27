import type { SimulationConfig } from "@/lib/types";
import { MODEL_VERSION } from "@/lib/physics/model";

/** JSON with sorted keys and rounded numbers, so equal configurations serialise identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    // 9 significant decimals: far below any parameter step, removes float noise.
    return String(Math.round(value * 1e9) / 1e9);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return "null";
}

/** 64-bit non-cryptographic string hash (two interleaved 32-bit FNV/Murmur-style mixes), hex encoded. */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h2) + hex(h1);
}

/**
 * Deterministic cache key for a simulation: geometry + environment + simulation
 * settings (+ model version, so cached results are invalidated when the model changes).
 */
export function hashConfig(config: SimulationConfig): string {
  return hashString(canonicalJson({ modelVersion: MODEL_VERSION, config }));
}
