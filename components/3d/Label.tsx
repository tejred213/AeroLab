"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

interface LabelProps {
  position: [number, number, number];
  text: string;
  color?: string;
  /** Draw a border and an opaque backing (for values that must stay readable over the flow). */
  boxed?: boolean;
  /** Text height on screen, CSS pixels. */
  size?: number;
}

const RESOLUTION = 2;
const FALLBACK_FONT = "system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/** The interface typeface, so labels in the scene match the panels around it. */
function interfaceFont(): string {
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-archivo").trim();
  return family ? `${family}, ${FALLBACK_FONT}` : FALLBACK_FONT;
}

/** Changes once the web fonts have loaded: a label drawn before that used the fallback face. */
function useFontsLoaded(): boolean {
  const [loaded, setLoaded] = useState(() => typeof document !== "undefined" && document.fonts.status === "loaded");
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return loaded;
}

/**
 * Text label anchored to a point in the scene, drawn as a screen-size sprite.
 * Rendered inside WebGL (no DOM overlay), so it costs one small texture.
 */
export function Label({ position, text, color = "#b4bbc5", boxed = false, size = 11 }: LabelProps) {
  const fontsLoaded = useFontsLoaded();
  const viewportHeight = useThree((state) => state.size.height);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;

  const { texture, aspect, heightPx } = useMemo(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const fontPx = size * RESOLUTION;
    const padX = (boxed ? 7 : 1) * RESOLUTION;
    const padY = (boxed ? 4 : 1) * RESOLUTION;
    const font = `${boxed ? 600 : 500} ${fontPx}px ${interfaceFont()}`;
    let width = 64;
    if (context) {
      context.font = font;
      width = Math.ceil(context.measureText(text).width);
    }
    canvas.width = width + 2 * padX;
    canvas.height = fontPx + 2 * padY;
    if (context) {
      if (boxed) {
        const inset = RESOLUTION / 2;
        context.beginPath();
        context.roundRect(inset, inset, canvas.width - RESOLUTION, canvas.height - RESOLUTION, 5 * RESOLUTION);
        context.fillStyle = "rgba(20, 23, 28, 0.92)";
        context.fill();
        context.strokeStyle = color;
        context.lineWidth = RESOLUTION;
        context.stroke();
      }
      context.font = font;
      // A boxed value is read against its backing: light text, with the border carrying the colour.
      context.fillStyle = boxed ? "#eceff3" : color;
      context.textBaseline = "middle";
      context.fillText(text, padX, canvas.height / 2 + RESOLUTION * 0.5);
    }
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.minFilter = THREE.LinearFilter;
    map.generateMipmaps = false;
    return { texture: map, aspect: canvas.width / canvas.height, heightPx: canvas.height / RESOLUTION };
    // fontsLoaded: redraw once the interface typeface is available.
  }, [text, color, boxed, size, fontsLoaded]);

  useEffect(() => () => texture.dispose(), [texture]);

  // With sizeAttenuation off a sprite of scale s spans s / (2 tan(fov / 2)) of the viewport height.
  const fov = (camera.fov ?? 32) * (Math.PI / 180);
  const scaleY = (heightPx / Math.max(viewportHeight, 1)) * 2 * Math.tan(fov / 2);
  return (
    <sprite position={position} scale={[scaleY * aspect, scaleY, 1]} renderOrder={10}>
      <spriteMaterial map={texture} sizeAttenuation={false} depthTest={false} depthWrite={false} transparent toneMapped={false} />
    </sprite>
  );
}
