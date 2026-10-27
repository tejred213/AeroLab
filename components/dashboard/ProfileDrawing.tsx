"use client";

import { useMemo } from "react";
import { sideOutline } from "@/lib/geometry/mesh";
import { buildBodyShape, spoilerGeometry, wheelGeometry, wingGeometry } from "@/lib/geometry/profile";
import { DEG_TO_RAD } from "@/lib/physics/model";
import type { GeometryParams } from "@/lib/types";

interface ProfileLayer {
  geometry: GeometryParams;
  color: string;
  dashed?: boolean;
  label?: string;
}

interface ProfileDrawingProps {
  layers: ProfileLayer[];
  /** Ground and frame colours for dark or light (print) backgrounds. */
  theme?: "dark" | "light";
  className?: string;
  ariaLabel: string;
}

const SCALE = 100; // SVG units per metre

/** Side-view outline of one or more geometries, drawn to scale and overlaid. */
export function ProfileDrawing({ layers, theme = "dark", className = "", ariaLabel }: ProfileDrawingProps) {
  const drawing = useMemo(() => {
    let maxLength = 0;
    let maxHeight = 0;
    const paths = layers.map((layer) => {
      const shape = buildBodyShape(layer.geometry);
      const outline = sideOutline(shape, 140);
      const ride = layer.geometry.rideHeight;
      const upper = outline.map((point) => `${(point.x * SCALE).toFixed(1)},${(-point.zUp * SCALE).toFixed(1)}`);
      const lower = outline
        .slice()
        .reverse()
        .map((point) => `${(point.x * SCALE).toFixed(1)},${(-point.zLow * SCALE).toFixed(1)}`);
      const wheels = wheelGeometry(shape);
      const spoiler = spoilerGeometry(shape);
      const wing = wingGeometry(shape);
      const angle = wing.angleDeg * DEG_TO_RAD;
      const half = wing.chord / 2;
      maxLength = Math.max(maxLength, shape.length + (spoiler.present ? spoiler.x1 - shape.length : 0));
      maxHeight = Math.max(maxHeight, ride + layer.geometry.roofHeight, wing.present ? ride + wing.zc + 0.1 : 0);
      return {
        layer,
        body: `M${upper.join(" L")} L${lower.join(" L")} Z`,
        wheels,
        spoiler: spoiler.present
          ? { x1: spoiler.x0, y1: -(ride + spoiler.z0), x2: spoiler.x1, y2: -(ride + spoiler.z1) }
          : null,
        wing: wing.present
          ? {
              x1: wing.xc - half * Math.cos(angle),
              y1: -(ride + wing.zc - half * Math.sin(angle)),
              x2: wing.xc + half * Math.cos(angle),
              y2: -(ride + wing.zc + half * Math.sin(angle)),
            }
          : null,
      };
    });
    return { paths, maxLength, maxHeight };
  }, [layers]);

  const margin = 0.25;
  const width = (drawing.maxLength + 2 * margin) * SCALE;
  const height = (drawing.maxHeight + margin + 0.08) * SCALE;
  const ground = theme === "dark" ? "#3b4350" : "#555";
  return (
    <svg
      viewBox={`${-margin * SCALE} ${-(drawing.maxHeight + margin) * SCALE} ${width} ${height}`}
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      <line x1={-margin * SCALE} x2={(drawing.maxLength + margin) * SCALE} y1={0} y2={0} stroke={ground} strokeWidth={1.5} />
      {drawing.paths.map(({ layer, body, wheels, spoiler, wing }, index) => (
        <g key={index} fill="none" stroke={layer.color} strokeWidth={1.8} strokeDasharray={layer.dashed ? "7 5" : undefined} strokeLinejoin="round">
          <path d={body} />
          {wheels.map((wheel) => (
            <circle key={wheel.x} cx={wheel.x * SCALE} cy={-wheel.z * SCALE} r={wheel.radius * SCALE} />
          ))}
          {spoiler && <line x1={spoiler.x1 * SCALE} y1={spoiler.y1 * SCALE} x2={spoiler.x2 * SCALE} y2={spoiler.y2 * SCALE} strokeWidth={3} />}
          {wing && <line x1={wing.x1 * SCALE} y1={wing.y1 * SCALE} x2={wing.x2 * SCALE} y2={wing.y2 * SCALE} strokeWidth={3} />}
        </g>
      ))}
    </svg>
  );
}
