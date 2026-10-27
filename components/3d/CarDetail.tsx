"use client";

/**
 * The dressed car: paint with a clear coat, glazing and pillars, door cuts,
 * lights, grille, wheel arches, detailed wheels and door mirrors.
 *
 * Four of these are drawn from parameters the aerodynamic models use, so the
 * picture shows what is computed: the door mirrors, how open the rims are, the
 * size of the grille and intakes, and the wheel-arch opening. The rest (paint,
 * glass, door cuts, lights) is appearance only. The body details are painted by
 * a fragment shader from the positions in lib/geometry/trim.ts, so they follow
 * the geometry parameters exactly and stay sharp at any zoom.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useStudioEnvironment } from "@/components/3d/studioEnvironment";
import { TOP_EDGE_RADIUS, type TrimLayout } from "@/lib/geometry/trim";
import type { CarAppearance } from "@/lib/vehicle/appearance";

const VERTEX_DECLARATIONS = /* glsl */ `
attribute vec3 aSection;
varying vec3 vBody;
varying vec3 vSection;
varying vec3 vObjNormal;
`;

const VERTEX_ASSIGNMENTS = /* glsl */ `
vBody = position;
vSection = aSection;
vObjNormal = normal;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 vBody;
varying vec3 vSection;
varying vec3 vObjNormal;
uniform vec3 uPaint;
uniform vec3 uRoofPaint;
uniform float uRoofMode;
uniform float uPaintRough;
uniform float uPaintMetal;
uniform float uRide;
uniform float uBelt;
uniform float uGreenhouse;
uniform float uCabin;
uniform float uTopRadius;
uniform float uCowl;
uniform float uMidRoof;
uniform float uScreenLow;
uniform float uBackLow;
uniform float uSlopeHigh;
uniform vec3 uRoofGlass;
uniform vec3 uGlassZ;
uniform vec4 uGlassX;
uniform vec2 uPillar[2];
uniform float uDoor[3];
uniform vec4 uSill;
uniform vec3 uHandle;
uniform vec4 uArch;
uniform vec2 uArchEdge;
uniform vec4 uHead;
uniform vec4 uHeadRound;
uniform vec4 uTail;
uniform vec3 uIntake;
uniform vec4 uGrille;
uniform float uGrilleMode;
uniform vec4 uRear;
uniform vec4 uExhaust;
`;

/**
 * Decides what each point of the body surface is (paint, glass, trim, a light, ...)
 * from its position in the body frame. Kinds: 0 paint, 1 glass, 2 black trim,
 * 3 bright metal, 4 headlight, 5 tail light, 6 shadow gap, 7 number plate, 8 roof colour.
 */
const FRAGMENT_SURFACE = /* glsl */ `
float dRough = uPaintRough;
float dMetal = uPaintMetal;
float dCoat = 1.0;
vec3 dCol = uPaint;
{
  float x = vBody.x;
  float ay = abs(vBody.y);
  float zb = vBody.z - uRide;
  float U = vSection.x;
  float Lw = vSection.y;
  float Pl = vSection.z;
  float sideness = abs(normalize(vObjNormal).y);
  bool isSide = sideness > 0.62;
  bool isCentral = sideness < 0.45;
  bool upperHalf = zb > 0.5 * (U + Lw);
  float len = uRear.x;
  float fx = fwidth(x) + 1e-5;
  float fy = fwidth(ay) + 1e-5;
  float fz = fwidth(zb) + 1e-5;
  int kind = 0;
  float ink = 0.0;

  // Wheel arches: openings in the body side, through which the wheels are seen.
  if (ay > uArchEdge.y) {
    float da = min(distance(vec2(x, zb), vec2(uArch.x, uArch.z)), distance(vec2(x, zb), vec2(uArch.y, uArch.z)));
    if (da < uArch.w) discard;
    if (da < uArch.w + uArchEdge.x && sideness > 0.35) kind = uSill.w > 0.5 ? 2 : 6;
  }

  // Roof in a second colour (fabric or black hardtop): everything above the belt of the cabin.
  if (uRoofMode > 0.5 && kind == 0 && x > uCowl && U > uBelt + 0.05 && zb > uBelt + 0.02) kind = 8;

  // Windscreen, rear window and glass roof, on the surfaces that face up, forward or back.
  float tg = clamp((U - uBelt) / uGreenhouse, 0.0, 1.0);
  float wTop = Pl * (1.0 - (1.0 - uCabin) * tg) - uTopRadius;
  if (isCentral && upperHalf && ay < wTop - 0.035) {
    if (x < uMidRoof && U > uScreenLow && U < uSlopeHigh) kind = 1;
    if (x > uMidRoof && U > uBackLow && U < uSlopeHigh) kind = 1;
    if (uRoofGlass.z > 0.5 && x > uRoofGlass.x && x < uRoofGlass.y && ay < wTop - 0.1 && U >= uSlopeHigh) kind = 1;
  }

  // Side glass: a four-sided opening with a dark surround, divided by pillars.
  if (uGlassZ.z > 0.5 && isSide && zb > uGlassZ.x && zb < uGlassZ.y) {
    float hh = (zb - uGlassZ.x) / (uGlassZ.y - uGlassZ.x);
    float xf = mix(uGlassX.x, uGlassX.y, hh);
    float xr = mix(uGlassX.z, uGlassX.w, hh);
    float d = min(min(zb - uGlassZ.x, uGlassZ.y - zb), 0.7 * min(x - xf, xr - x));
    d = min(d, U - 0.06 - zb);
    if (d > 0.0) {
      kind = d > 0.012 ? 1 : 2;
      for (int i = 0; i < 2; i++) {
        if (uPillar[i].y > 0.0 && abs(x - uPillar[i].x) < uPillar[i].y) kind = 2;
      }
    }
  }

  // Lights.
  if (kind == 0) {
    if (x < uHead.x && upperHalf) {
      if (uHeadRound.z > 0.0) {
        // A sphere around a point of the surface marks out a round lamp on it, whatever the surface's slope.
        float dh = distance(vec3(x, ay, zb), vec3(uHeadRound.w, uHeadRound.xy));
        if (dh < uHeadRound.z) kind = 4;
        else if (dh < uHeadRound.z + 0.014) kind = 3;
      } else if (abs(zb - uHead.y) < uHead.z && ay > uHead.w) {
        kind = 4;
      }
    }
    if (x > uTail.x && abs(zb - uTail.y) < uTail.z && ay >= uTail.w) kind = 5;
  }

  // Front: lower intake and upper grille.
  if (kind == 0 && x < 0.45) {
    if (zb > uIntake.x && zb < uIntake.y && ay < uIntake.z) kind = 2;
    if (uGrilleMode > 0.5 && zb > uGrille.x && zb < uGrille.y && ay < uGrille.z && ay > uGrille.w) {
      kind = 2;
      float inner = uGrille.w > 0.0 ? ay - uGrille.w : 1.0;
      float edge = min(min(zb - uGrille.x, uGrille.y - zb), min(uGrille.z - ay, inner));
      if (uGrilleMode > 1.5) {
        if (fract(ay / 0.085 + 0.5) < 0.36) kind = 0;
      } else if (edge < 0.011) {
        kind = 3;
      }
    }
  }

  // Rear: lower valance, number plate and exhaust tips.
  if (kind == 0 && x > len - 0.3) {
    bool cap = x > len - 0.012;
    if (isCentral && zb < Lw + 0.11) kind = 2;
    if (cap && ay < 0.26 && zb > uRear.y && zb < uRear.y + 0.115) kind = 7;
    if (uExhaust.z > 0.0 && cap) {
      float de = distance(vec2(ay, zb), uExhaust.xy);
      if (uExhaust.w > 1.5) de = min(de, distance(vec2(ay, zb), uExhaust.xy - vec2(0.105, 0.0)));
      if (de < uExhaust.z) kind = de < uExhaust.z - 0.011 ? 2 : 3;
    }
  }

  // Bonnet and boot: the cowl under the windscreen and the shut lines.
  if (isCentral && upperHalf && kind == 0) {
    if (x > uCowl - 0.015 && x < uMidRoof && U <= uScreenLow && U < uSlopeHigh && ay < Pl - 0.14) kind = 2;
    if (x > 0.32 && x < uCowl - 0.015) ink = max(ink, 1.0 - smoothstep(0.003, 0.003 + fy, abs(ay - (Pl - 0.14))));
    if (uRear.w > 0.25 && x > uRear.z + 0.035 && x < len - 0.02) {
      ink = max(ink, 1.0 - smoothstep(0.003, 0.003 + fy, abs(ay - (Pl - 0.16))));
    }
    if (uRear.w > 0.25 && ay < Pl - 0.16) ink = max(ink, 1.0 - smoothstep(0.003, 0.003 + fx, abs(x - uRear.z - 0.035)));
  }

  // Doors: cuts from the sill to the belt, the sill line and the handles.
  if (isSide && kind == 0) {
    if (zb > uSill.x && zb < uBelt + 0.012) {
      for (int i = 0; i < 3; i++) {
        if (uDoor[i] > 0.0) ink = max(ink, 1.0 - smoothstep(0.0035, 0.0035 + fx, abs(x - uDoor[i])));
      }
    }
    if (x > uSill.y && x < uSill.z) ink = max(ink, 1.0 - smoothstep(0.0035, 0.0035 + fz, abs(zb - uSill.x)));
    for (int i = 0; i < 2; i++) {
      float hx = i == 0 ? uHandle.x : uHandle.y;
      vec2 q = abs(vec2(x - hx, zb - uHandle.z)) - vec2(0.07, 0.011);
      if (hx > 0.0 && max(q.x, q.y) < 0.0) kind = 3;
    }
    if (uSill.w > 0.5 && zb < 0.17) kind = 2;
  }

  // The inside of the shell, seen through the wheel arches.
  if (!gl_FrontFacing) {
    kind = 2;
    ink = 0.0;
  }

  if (kind == 1) {
    dCol = vec3(0.012, 0.016, 0.022); dRough = 0.04; dMetal = 0.0;
  } else if (kind == 2) {
    dCol = vec3(0.011); dRough = 0.72; dMetal = 0.0; dCoat = 0.0;
  } else if (kind == 3) {
    dCol = vec3(0.62, 0.64, 0.67); dRough = 0.2; dMetal = 1.0; dCoat = 0.0;
  } else if (kind == 4) {
    dCol = vec3(0.75, 0.78, 0.8); dRough = 0.08; dMetal = 0.1;
    totalEmissiveRadiance += vec3(1.0, 0.96, 0.88) * 0.85;
  } else if (kind == 5) {
    dCol = vec3(0.22, 0.004, 0.004); dRough = 0.12; dMetal = 0.0;
    totalEmissiveRadiance += vec3(0.95, 0.02, 0.015) * 0.75;
  } else if (kind == 6) {
    dCol = uPaint * 0.08; dRough = 0.8; dMetal = 0.0; dCoat = 0.0;
  } else if (kind == 7) {
    dCol = vec3(0.8); dRough = 0.6; dMetal = 0.0; dCoat = 0.0;
  } else if (kind == 8) {
    dCol = uRoofPaint; dRough = 0.85; dMetal = 0.0; dCoat = 0.0;
  }
  if (kind == 0 || kind == 8) {
    dCol *= 1.0 - 0.92 * ink;
    dRough = mix(dRough, 0.8, ink);
    dCoat *= 1.0 - ink;
  }
  diffuseColor.rgb = dCol;
}
`;

const PROGRAM_KEY = "aerolab-car-paint-3";
const ENVIRONMENT_INTENSITY = 0.45;
const PAINT_ALBEDO = 0.78;

interface PaintUniforms {
  [name: string]: THREE.IUniform;
}

function createUniforms(): PaintUniforms {
  return {
    uPaint: { value: new THREE.Color() },
    uRoofPaint: { value: new THREE.Color(0.012, 0.012, 0.013) },
    uRoofMode: { value: 0 },
    uPaintRough: { value: 0.3 },
    uPaintMetal: { value: 0.5 },
    uRide: { value: 0 },
    uBelt: { value: 0 },
    uGreenhouse: { value: 1 },
    uCabin: { value: 1 },
    uTopRadius: { value: TOP_EDGE_RADIUS },
    uCowl: { value: 0 },
    uMidRoof: { value: 0 },
    uScreenLow: { value: 0 },
    uBackLow: { value: 0 },
    uSlopeHigh: { value: 0 },
    uRoofGlass: { value: new THREE.Vector3() },
    uGlassZ: { value: new THREE.Vector3() },
    uGlassX: { value: new THREE.Vector4() },
    uPillar: { value: [new THREE.Vector2(), new THREE.Vector2()] },
    uDoor: { value: [0, 0, 0] },
    uSill: { value: new THREE.Vector4() },
    uHandle: { value: new THREE.Vector3() },
    uArch: { value: new THREE.Vector4() },
    uArchEdge: { value: new THREE.Vector2() },
    uHead: { value: new THREE.Vector4() },
    uHeadRound: { value: new THREE.Vector4() },
    uTail: { value: new THREE.Vector4() },
    uIntake: { value: new THREE.Vector3() },
    uGrille: { value: new THREE.Vector4() },
    uGrilleMode: { value: 0 },
    uRear: { value: new THREE.Vector4() },
    uExhaust: { value: new THREE.Vector4() },
  };
}

function applyLayout(uniforms: PaintUniforms, layout: TrimLayout, look: CarAppearance): void {
  const u = uniforms;
  // The scene lighting is bright; a slightly darker base keeps strong colours from washing out.
  (u.uPaint.value as THREE.Color).set(look.paint).multiplyScalar(PAINT_ALBEDO);
  u.uRoofMode.value = look.roof === "black" ? 1 : 0;
  u.uPaintMetal.value = look.metallic;
  u.uPaintRough.value = 0.36 - 0.1 * look.metallic;
  u.uRide.value = layout.ride;
  u.uBelt.value = layout.belt;
  u.uGreenhouse.value = layout.greenhouse;
  u.uCabin.value = layout.cabinRatio;
  u.uCowl.value = layout.cowl;
  u.uMidRoof.value = layout.midRoof;
  u.uScreenLow.value = layout.screenLow;
  u.uBackLow.value = layout.backLow;
  u.uSlopeHigh.value = layout.slopeHigh;
  (u.uRoofGlass.value as THREE.Vector3).set(layout.roofGlass?.[0] ?? 0, layout.roofGlass?.[1] ?? 0, layout.roofGlass ? 1 : 0);

  const glass = layout.sideGlass;
  (u.uGlassZ.value as THREE.Vector3).set(glass?.bottom ?? 0, glass?.top ?? 1, glass ? 1 : 0);
  (u.uGlassX.value as THREE.Vector4).set(glass?.front[0] ?? 0, glass?.front[1] ?? 0, glass?.rear[0] ?? 0, glass?.rear[1] ?? 0);
  const pillars = u.uPillar.value as THREE.Vector2[];
  for (let i = 0; i < 2; i++) pillars[i].set(glass?.pillars[i]?.[0] ?? 0, glass?.pillars[i]?.[1] ?? 0);

  const doors = u.uDoor.value as number[];
  for (let i = 0; i < 3; i++) doors[i] = layout.doorLines[i] ?? 0;
  (u.uSill.value as THREE.Vector4).set(layout.sill, layout.sillRange[0], layout.sillRange[1], look.cladding ? 1 : 0);
  (u.uHandle.value as THREE.Vector3).set(layout.handles[0] ?? 0, layout.handles[1] ?? 0, layout.handleZ);
  (u.uArch.value as THREE.Vector4).set(layout.arch.x[0], layout.arch.x[1], layout.arch.z, layout.arch.radius);
  (u.uArchEdge.value as THREE.Vector2).set(layout.arch.lip, layout.arch.innerY);

  (u.uHead.value as THREE.Vector4).set(layout.head.xMax, layout.head.z, layout.head.halfHeight, layout.head.innerY);
  const round = layout.head.round;
  (u.uHeadRound.value as THREE.Vector4).set(round?.y ?? 0, round?.z ?? 0, round?.radius ?? 0, round?.x ?? 0);
  (u.uTail.value as THREE.Vector4).set(layout.tail.xMin, layout.tail.z, layout.tail.halfHeight, layout.tail.innerY);
  (u.uIntake.value as THREE.Vector3).set(layout.intake.low, layout.intake.high, layout.intake.halfWidth);
  const grille = layout.grille;
  (u.uGrille.value as THREE.Vector4).set(grille?.low ?? 0, grille?.high ?? 0, grille?.outerY ?? 0, grille?.innerY ?? 0);
  u.uGrilleMode.value = grille ? (grille.slats ? 2 : 1) : 0;
  (u.uRear.value as THREE.Vector4).set(layout.length, layout.plateZ, layout.deckStart, layout.deckLength);
  const exhaust = layout.exhaust;
  (u.uExhaust.value as THREE.Vector4).set(exhaust?.y ?? 0, exhaust?.z ?? 0, exhaust?.radius ?? 0, exhaust?.pairs ?? 0);
}

/** Car paint for the body mesh. The geometry needs the "aSection" attribute (see sectionAttribute). */
export function useCarPaintMaterial(layout: TrimLayout, look: CarAppearance): THREE.MeshPhysicalMaterial {
  const environment = useStudioEnvironment();
  const { material, uniforms } = useMemo(() => {
    const paintUniforms = createUniforms();
    const paint = new THREE.MeshPhysicalMaterial({
      color: "#ffffff",
      roughness: 0.3,
      metalness: 0.5,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      side: THREE.DoubleSide,
    });
    paint.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, paintUniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_DECLARATIONS}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERTEX_ASSIGNMENTS}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAGMENT_DECLARATIONS}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_SURFACE}`)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = dRough;")
        .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = dMetal;")
        .replace(
          "#include <lights_physical_fragment>",
          "#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= dCoat;\n#endif",
        );
    };
    paint.customProgramCacheKey = () => PROGRAM_KEY;
    return { material: paint, uniforms: paintUniforms };
  }, []);

  useEffect(() => () => material.dispose(), [material]);
  // Uniforms are plain values read at draw time: updating them needs no recompilation.
  applyLayout(uniforms, layout, look);
  material.envMap = environment;
  // The scene is already lit by an ambient and two directional lights; the environment adds reflections on top.
  material.envMapIntensity = ENVIRONMENT_INTENSITY;
  return material;
}

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

type Wheel = TrimLayout["wheels"][number];

/** Cross-section of a tyre (radius against position along the axle), revolved around the axle. */
function tyreProfile(radius: number, width: number, rimRadius: number): THREE.Vector2[] {
  const half = width / 2;
  const wall = radius - rimRadius;
  const shoulder = Math.min(0.03, 0.35 * wall);
  const points: [number, number][] = [
    [rimRadius, -0.8 * half],
    [rimRadius + 0.45 * wall, -0.99 * half],
    [radius - 1.3 * shoulder, -half],
    [radius - 0.25 * shoulder, -half + 0.45 * shoulder],
    [radius, -half + shoulder],
    [radius, half - shoulder],
    [radius - 0.25 * shoulder, half - 0.45 * shoulder],
    [radius - 1.3 * shoulder, half],
    [rimRadius + 0.45 * wall, 0.99 * half],
    [rimRadius, 0.8 * half],
  ];
  return points.map(([r, y]) => new THREE.Vector2(r, y));
}

interface Spoke {
  angle: number;
  width: number;
}

/** Rims below this openness are drawn as closed covers with slots, above it as spokes. */
const COVER_OPENNESS = 0.35;

function spokesFor(look: CarAppearance, rimRadius: number, openness: number): Spoke[] {
  const ring = (count: number, width: number, offsets: number[] = [0]) =>
    Array.from({ length: count }).flatMap((_, k) => offsets.map((offset) => ({ angle: (2 * Math.PI * k) / count + offset, width })));
  // Slots of a closed cover: fewer and narrower the more closed it is.
  if (openness < COVER_OPENNESS) return openness < 0.05 ? [] : ring(5, (0.05 + 0.2 * openness) * rimRadius);
  // Spokes: the pattern is styling, their width follows the openness (open rims have thin spokes).
  const slim = Math.min(Math.max(1.6 - 1.2 * openness, 0.5), 1.3);
  if (look.rim === "multi") return ring(10, 0.085 * slim * rimRadius);
  if (look.rim === "offroad") return ring(6, 0.3 * slim * rimRadius);
  return ring(5, 0.085 * slim * rimRadius, [-0.14, 0.14]);
}

function DetailedWheel({ wheel, side, look, openness, environment }: { wheel: Wheel; side: 1 | -1; look: CarAppearance; openness: number; environment: THREE.Texture }) {
  const { radius, width, rimRadius } = wheel;
  const tyre = useMemo(() => new THREE.LatheGeometry(tyreProfile(radius, width, rimRadius), 48), [radius, width, rimRadius]);
  useEffect(() => () => tyre.dispose(), [tyre]);

  const hub = 0.2 * rimRadius;
  const face = width / 2 - 0.03;
  const spokeLength = rimRadius - hub;
  const aero = openness < COVER_OPENNESS;
  const rimMaterial = <meshStandardMaterial color={look.rimColor} metalness={0.92} roughness={0.28} envMap={environment} envMapIntensity={0.7} />;
  const darkMetal = <meshStandardMaterial color="#17191c" metalness={0.6} roughness={0.5} envMap={environment} />;

  return (
    // The outer face of the wheel is local +Y; the wheels of the other side are turned round, not mirrored.
    <group position={[wheel.x, side * wheel.y, wheel.z]} rotation={[0, 0, side > 0 ? 0 : Math.PI]}>
      <mesh geometry={tyre}>
        <meshStandardMaterial color="#0b0c0e" roughness={0.9} metalness={0} />
      </mesh>
      {/* Rim barrel and the dark space behind the spokes. */}
      <mesh>
        <cylinderGeometry args={[rimRadius, rimRadius, 0.8 * width, 40, 1, true]} />
        <meshStandardMaterial color={look.rimColor} metalness={0.9} roughness={0.35} envMap={environment} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.12 * width, 0]}>
        <cylinderGeometry args={[rimRadius, rimRadius, 0.004, 40]} />
        <meshStandardMaterial color="#050506" roughness={1} />
      </mesh>
      {/* Brake disc and caliper. */}
      <mesh position={[0, 0.08 * width, 0]}>
        <cylinderGeometry args={[0.74 * rimRadius, 0.74 * rimRadius, 0.024, 36]} />
        <meshStandardMaterial color="#70757b" metalness={0.85} roughness={0.42} envMap={environment} />
      </mesh>
      <mesh position={[-0.56 * rimRadius, 0.08 * width + 0.012, 0.3 * rimRadius]} rotation={[0, 0.5, 0]}>
        <boxGeometry args={[0.2 * rimRadius, 0.06, 0.46 * rimRadius]} />
        <meshStandardMaterial color={look.caliper ?? "#2a2c2f"} metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Rim lip. */}
      <mesh position={[0, 0.8 * (width / 2), 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[rimRadius - 0.004, 0.011, 8, 48]} />
        {rimMaterial}
      </mesh>
      {aero && (
        <mesh position={[0, face, 0]}>
          <cylinderGeometry args={[0.975 * rimRadius, 0.975 * rimRadius, 0.012, 48]} />
          {rimMaterial}
        </mesh>
      )}
      {spokesFor(look, rimRadius, openness).map((spoke, index) => (
        <group key={index} rotation={[0, spoke.angle, 0]}>
          {aero ? (
            // Slots in the cover, drawn as dark inlays.
            <mesh position={[0.62 * rimRadius, face + 0.007, 0]}>
              <boxGeometry args={[0.5 * rimRadius, 0.004, spoke.width]} />
              {darkMetal}
            </mesh>
          ) : (
            <mesh position={[hub + spokeLength / 2, face, 0]}>
              <boxGeometry args={[spokeLength, 0.022, spoke.width]} />
              {rimMaterial}
            </mesh>
          )}
        </group>
      ))}
      <mesh position={[0, face + 0.006, 0]}>
        <cylinderGeometry args={[hub, 1.15 * hub, 0.03, 24]} />
        {aero ? darkMetal : rimMaterial}
      </mesh>
    </group>
  );
}

/** Tyres, rims and brakes at the simulated wheel positions, plus the dark wheel housings behind them. */
export function DetailedWheels({ layout, look }: { layout: TrimLayout; look: CarAppearance }) {
  const environment = useStudioEnvironment();
  const { arch, ride } = layout;
  // The housing is the part of a drum around the wheel that lies above the floor of the body.
  const centreZ = arch.z + ride;
  const drum = arch.radius + 0.004;
  const cut = Math.min(Math.max((ride + 0.004 - centreZ) / drum, -1), 1);
  const sweep = Math.acos(cut);

  return (
    <group>
      {layout.wheels.map((wheel) =>
        ([1, -1] as const).map((side) => {
          const outer = wheel.y + wheel.width / 2 + 0.03;
          const depth = Math.max(outer - arch.innerY, 0.05);
          return (
            <group key={`${wheel.x}-${side}`}>
              <DetailedWheel wheel={wheel} side={side} look={look} openness={layout.rimOpenness} environment={environment} />
              <group position={[wheel.x, side * (arch.innerY + depth / 2), centreZ]}>
                <mesh>
                  <cylinderGeometry args={[drum, drum, depth, 40, 1, true, -sweep, 2 * sweep]} />
                  <meshStandardMaterial color="#050506" roughness={1} side={THREE.DoubleSide} />
                </mesh>
                <mesh position={[0, (-side * depth) / 2, 0]}>
                  <cylinderGeometry args={[drum, drum, 0.004, 40, 1, false, -sweep, 2 * sweep]} />
                  <meshStandardMaterial color="#050506" roughness={1} side={THREE.DoubleSide} />
                </mesh>
              </group>
            </group>
          );
        }),
      )}
    </group>
  );
}

/**
 * Door mirrors, the size and at the place the aerodynamic models use (lib/geometry/profile.ts,
 * mirrorGeometry): a housing on a short foot at the base of the A-pillar. Nothing is drawn without mirrors.
 */
export function Mirrors({ layout, look }: { layout: TrimLayout; look: CarAppearance }) {
  const environment = useStudioEnvironment();
  const mirrorPaint = useMemo(() => new THREE.Color(look.paint).multiplyScalar(PAINT_ALBEDO), [look.paint]);
  const { mirror } = layout;
  if (!mirror) return null;
  // The foot takes the inner part of the span; the housing fills the rest, out to the full mirror width.
  const foot = Math.min(0.035, 0.25 * mirror.width);
  const halfSpan = 0.5 * (mirror.width - foot);
  const centre = foot + halfSpan;
  return (
    <group>
      {([1, -1] as const).map((side) => (
        <group key={side} position={[mirror.x, side * mirror.y, mirror.z]}>
          <mesh position={[0, side * 0.5 * foot, -0.25 * mirror.height]}>
            <boxGeometry args={[0.7 * mirror.depth, foot + 0.04, 0.3 * mirror.height]} />
            <meshStandardMaterial color="#0b0c0e" roughness={0.7} />
          </mesh>
          <mesh position={[0, side * centre, 0]} scale={[0.6 * mirror.depth, halfSpan, 0.5 * mirror.height]}>
            <sphereGeometry args={[1, 24, 16]} />
            <meshPhysicalMaterial
              color={mirrorPaint}
              metalness={look.metallic}
              roughness={0.36 - 0.1 * look.metallic}
              clearcoat={1}
              clearcoatRoughness={0.05}
              envMap={environment}
              envMapIntensity={ENVIRONMENT_INTENSITY}
            />
          </mesh>
          {/* The mirror glass, facing backwards. */}
          <mesh position={[0.52 * mirror.depth, side * centre, 0]} rotation={[0, Math.PI / 2, 0]} scale={[0.4 * mirror.height, 0.8 * halfSpan, 1]}>
            <circleGeometry args={[1, 24]} />
            <meshStandardMaterial color="#8a949e" metalness={1} roughness={0.08} envMap={environment} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** The body with its paint and details, the detailed wheels and the mirrors. */
export function DressedCar({ geometry, layout, look }: { geometry: THREE.BufferGeometry; layout: TrimLayout; look: CarAppearance }) {
  const paint = useCarPaintMaterial(layout, look);
  return (
    <group>
      <mesh geometry={geometry} material={paint} />
      <DetailedWheels layout={layout} look={look} />
      <Mirrors layout={layout} look={look} />
    </group>
  );
}
