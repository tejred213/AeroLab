"use client";

import dynamic from "next/dynamic";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { VISUAL_FREESTREAM_SPEED } from "@/components/3d/FlowParticles";
import { JobStatusCard } from "@/components/simulator/JobStatus";
import { Button, ButtonGroup, Kbd } from "@/components/ui/Button";
import { Chevron } from "@/components/ui/Layout";
import { Checkbox, Select } from "@/components/ui/Field";
import { useCfdSurfaceStore } from "@/lib/import/cfdSurface";
import { type ImportedModelView, useImportedModel } from "@/lib/import/useImportedModel";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { currentVehicle, useSimStore } from "@/lib/state/simStore";
import {
  type CameraPreset,
  type LayerId,
  useFlowStore,
  useViewStore,
  type VisualizationMode,
} from "@/lib/state/viewStore";
import { PRESSURE_RANGE, SCALE_CSS_GRADIENT, VELOCITY_RANGE } from "@/lib/utils/colormap";
import { formatWithUnit, unitOf } from "@/lib/utils/units";
import { appearanceFor } from "@/lib/vehicle/appearance";

// The WebGL scene is loaded on demand and never rendered on the server.
const TunnelScene = dynamic(() => import("@/components/3d/TunnelScene").then((module) => module.TunnelScene), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-[13px] text-ink-3">Loading 3D viewport…</div>,
});

const MODES: { id: VisualizationMode; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "wireframe", label: "Wireframe" },
  { id: "transparent", label: "Transparent" },
  { id: "pressure", label: "Pressure" },
  { id: "velocity", label: "Velocity" },
  { id: "streamlines", label: "Streamlines" },
  { id: "wake", label: "Wake" },
];

const LAYERS: { id: LayerId; label: string }[] = [
  { id: "airflow", label: "Airflow particles" },
  { id: "streamlines", label: "Streamlines" },
  { id: "velocity", label: "Velocity field (slice)" },
  { id: "pressure", label: "Pressure field (slice)" },
  { id: "wake", label: "Wake" },
  { id: "separation", label: "Flow separation" },
  { id: "forces", label: "Force vectors" },
];

const CAMERAS: { id: CameraPreset; label: string; key?: string }[] = [
  { id: "perspective", label: "Perspective", key: "1" },
  { id: "front", label: "Front", key: "2" },
  { id: "side", label: "Side", key: "3" },
  { id: "top", label: "Top", key: "4" },
  { id: "rear", label: "Rear", key: "5" },
  { id: "three-quarter", label: "3/4" },
];

interface LegendProps {
  title: string;
  ticks: string[];
}

function Legend({ title, ticks }: LegendProps) {
  return (
    <div className="w-[240px]">
      <div className="mb-1.5 text-xs font-medium text-ink">{title}</div>
      <div className="h-2 rounded-full" style={{ background: SCALE_CSS_GRADIENT }} aria-hidden />
      <div className="num mt-1 flex justify-between text-[11px] text-ink-2">
        {ticks.map((tick, index) => (
          <span key={index}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

function LayerMenu() {
  const layers = useViewStore((state) => state.layers);
  const toggleLayer = useViewStore((state) => state.toggleLayer);
  const bodyStyle = useViewStore((state) => state.bodyStyle);
  const setBodyStyle = useViewStore((state) => state.setBodyStyle);
  const bodyOpacity = useViewStore((state) => state.bodyOpacity);
  const setBodyOpacity = useViewStore((state) => state.setBodyOpacity);
  const detail = useViewStore((state) => state.detail);
  const setDetail = useViewStore((state) => state.setDetail);
  const sliceAxis = useViewStore((state) => state.sliceAxis);
  const slicePosition = useViewStore((state) => state.slicePosition);
  const setSlice = useViewStore((state) => state.setSlice);
  const hasField = useFlowStore((state) => state.field !== null);
  const sliceActive = layers.velocity || layers.pressure;

  const sliceRange: Record<"x" | "y" | "z", [number, number]> = { x: [-2, 10], y: [-1.6, 1.6], z: [0.02, 2.2] };
  const [min, max] = sliceRange[sliceAxis];
  return (
    // The height is capped to the viewport (a size container), so a short viewport scrolls the menu instead of clipping it.
    <div className="scroll-thin max-h-[calc(100cqh-4.5rem)] w-64 overflow-y-auto overscroll-contain rounded-2xl border border-line-strong bg-panel/95 p-3.5 shadow-xl shadow-black/50 backdrop-blur-md">
      <div className="label mb-1">Flow layers</div>
      {LAYERS.map((layer) => (
        <Checkbox
          key={layer.id}
          checked={layers[layer.id]}
          disabled={!hasField}
          label={layer.label}
          onChange={() => toggleLayer(layer.id)}
        />
      ))}
      <Checkbox
        checked={bodyStyle === "pressure"}
        disabled={!hasField}
        label="Surface pressure"
        onChange={(checked) => setBodyStyle(checked ? "pressure" : "solid")}
      />
      {!hasField && <p className="mt-1 text-xs text-ink-3">Run a simulation to compute a flow field.</p>}

      <div className="label mt-3.5 mb-1">Solid view</div>
      <Checkbox
        checked={detail}
        label="Car detail"
        hint="Paint, glass, door lines and lights are drawn only. Mirrors, rims, intakes and wheel arches are drawn from the parameters the calculation uses."
        onChange={setDetail}
      />

      <div className="label mt-3.5 mb-1">Body opacity (transparent style)</div>
      <input
        type="range"
        aria-label="Body opacity"
        className="block w-full"
        style={{ "--fill": `${((bodyOpacity - 0.05) / 0.95) * 100}%` } as CSSProperties}
        min={0.05}
        max={1}
        step={0.05}
        value={bodyOpacity}
        onChange={(event) => {
          setBodyOpacity(Number(event.target.value));
          if (bodyStyle !== "transparent") setBodyStyle("transparent");
        }}
      />

      <div className="label mt-3.5 mb-1">Slice plane</div>
      <div className="flex items-center gap-2">
        <Select
          ariaLabel="Slice plane orientation"
          value={sliceAxis}
          disabled={!sliceActive}
          options={[
            { value: "y", label: "Side (Y)" },
            { value: "z", label: "Plan (Z)" },
            { value: "x", label: "Cross (X)" },
          ]}
          onChange={(axis) => setSlice(axis, axis === "y" ? 0 : axis === "z" ? 0.6 : 2)}
        />
        <span className="num text-xs text-ink-2">
          {sliceAxis} = {slicePosition.toFixed(2)} m
        </span>
      </div>
      <input
        type="range"
        aria-label="Slice plane position"
        className="mt-1.5 block w-full"
        style={{ "--fill": `${((Math.min(Math.max(slicePosition, min), max) - min) / (max - min)) * 100}%` } as CSSProperties}
        disabled={!sliceActive}
        min={min}
        max={max}
        step={0.02}
        value={Math.min(Math.max(slicePosition, min), max)}
        onChange={(event) => setSlice(sliceAxis, Number(event.target.value))}
      />
    </div>
  );
}

/** Message card floating over the viewport. */
const NOTICE = "rounded-xl border border-line-strong/80 bg-panel/90 px-3 py-2 text-center text-xs leading-relaxed backdrop-blur-md";

/** How long the notice about an imported model stays up before it removes itself, ms. */
const NOTICE_DURATION = 15_000;

type NoticeKind = "problem" | "model" | "edited";

function noticeKindOf(imported: ImportedModelView): NoticeKind {
  return imported.problem ? "problem" : imported.active ? "model" : "edited";
}

/**
 * Notice over the viewport about the imported 3D model in the tunnel. It can be closed and removes
 * itself after 15 seconds (the countdown waits while the pointer or the keyboard focus is on it). It comes
 * back when what it says changes: another model, a shape parameter edited, or the model's files missing.
 * The one-line caption at the bottom left stays, so what the solver works on is always stated.
 */
function ImportedNotice({ imported, onRestore }: { imported: ImportedModelView; onRestore: () => void }) {
  const kind = noticeKindOf(imported);
  const key = `${imported.model.bodyId}:${kind}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const visible = dismissed !== key;

  useEffect(() => {
    if (!visible || held) return;
    const timer = window.setTimeout(() => setDismissed(key), NOTICE_DURATION);
    return () => window.clearTimeout(timer);
  }, [key, visible, held]);

  if (!visible) return null;
  const attachment = imported.model.measured.rearAttachment ?? 0;
  return (
    <div
      role="status"
      className={`pointer-events-auto relative !pr-8 ${NOTICE} text-ink-2`}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {kind === "problem" ? (
        <span className="text-warn">{imported.problem}</span>
      ) : kind === "model" ? (
        <>
          <span className="font-semibold text-ink">Imported 3D model.</span> The solver sees its outer envelope (
          {Math.round(imported.model.resolution * 1000)} mm samples); the Solid view shows the model, the other views show
          that envelope. Model accuracy is not verified.
          {attachment > 0 &&
            ` The rear-mounted spare wheel (${Math.round(attachment * 1000)} mm) is drawn but is not part of the solver's body.`}
        </>
      ) : (
        <>
          A shape parameter was changed, so the fitted parametric shape is shown and solved, not the imported model.{" "}
          <button type="button" className="text-accent underline underline-offset-2" onClick={onRestore}>
            Restore the model shape
          </button>
        </>
      )}
      <button
        type="button"
        aria-label="Close this notice"
        title="Close"
        className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center text-ink-3 transition-colors hover:bg-raise hover:text-ink"
        onClick={() => setDismissed(key)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** What stays on screen after the notice has gone: one line saying what the solver works on. */
function ImportedCaption({ imported, onRestore }: { imported: ImportedModelView; onRestore: () => void }) {
  const kind = noticeKindOf(imported);
  return (
    <p className={`max-w-[420px] text-[11px] leading-normal ${kind === "problem" ? "text-warn" : "text-ink-3"}`}>
      {kind === "problem" ? (
        imported.problem
      ) : kind === "model" ? (
        <>
          <span className="font-semibold text-ink-2">Imported 3D model:</span> solved on its outer envelope (
          {Math.round(imported.model.resolution * 1000)} mm samples), not on the mesh.
        </>
      ) : (
        <>
          <span className="font-semibold text-ink-2">Imported 3D model:</span> a shape parameter was changed, so the fitted
          parametric shape is shown and solved.{" "}
          <button type="button" className="pointer-events-auto text-accent underline underline-offset-2" onClick={onRestore}>
            Restore the model shape
          </button>
        </>
      )}
    </p>
  );
}

const DETAIL_NOTE =
  "Mirrors, rim openness, cooling intakes and wheel-arch opening are part of the calculation (Details and Wheels in the geometry panel). Glass, door lines, lights and paint are drawn only.";

/**
 * @param compact phone layout: each toolbar is a single horizontally scrolling row without
 *   keyboard hints, so the controls do not cover the small viewport.
 */
export function Viewport({ stale, compact = false }: { stale: boolean; compact?: boolean }) {
  const geometry = useSimStore((state) => state.geometry);
  const setGeometry = useSimStore((state) => state.setGeometry);
  const vehicle = useSimStore((state) => currentVehicle(state));
  const detail = useViewStore((state) => state.detail);
  const appearance = useMemo(() => (detail ? appearanceFor(vehicle, geometry) : null), [detail, vehicle, geometry]);
  const imported = useImportedModel();
  // The envelope and the painted model apply only while the shape parameters are the fitted ones.
  const bodyId = imported?.active && imported.bodyReady ? imported.model.bodyId : undefined;
  const painted = useMemo(
    () =>
      imported?.active && imported.scene
        ? { scene: imported.scene, matrix: imported.model.matrix, lift: geometry.rideHeight - imported.model.rideHeight }
        : null,
    [imported?.active, imported?.scene, imported?.model, geometry.rideHeight],
  );
  const result = useSimStore((state) => state.result);
  const running = useSimStore((state) => state.running);
  const field = useFlowStore((state) => state.field);
  const system = useSettingsStore((state) => state.unitSystem);
  const particleCount = useSettingsStore((state) => state.particleCount);
  const view = useViewStore();
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);

  const formatForce = useCallback((newton: number) => formatWithUnit(system, "force", newton), [system]);

  const freestream = field?.freestream.speed ?? 0;
  const speedUnit = unitOf(system, "speed");
  const velocityTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    speedUnit.toDisplay((VELOCITY_RANGE[0] + fraction * (VELOCITY_RANGE[1] - VELOCITY_RANGE[0])) * freestream).toFixed(0),
  );
  const showVelocityLegend = field !== null && (view.layers.airflow || view.layers.streamlines || view.layers.velocity);
  const showPressureLegend = field !== null && (view.layers.pressure || view.bodyStyle === "pressure");
  // Real-time factor of the animation: on screen the freestream moves at VISUAL_FREESTREAM_SPEED.
  const slowdown = freestream > 0.5 ? freestream / VISUAL_FREESTREAM_SPEED : null;

  // The closed surface built for Mode C, when the user asks to see it in place of the model.
  const showWrap = useCfdSurfaceStore((state) => state.show);
  const storedWrap = useCfdSurfaceStore((state) => (imported ? state.wraps[imported.model.bodyId] : undefined));
  const wrap = useMemo(
    () =>
      imported?.active && showWrap && storedWrap
        ? { positions: storedWrap.positions, indices: storedWrap.indices, lift: geometry.rideHeight - imported.model.rideHeight }
        : null,
    [imported?.active, imported?.model, showWrap, storedWrap, geometry.rideHeight],
  );

  const restoreModelShape = useCallback(() => {
    if (imported) setGeometry({ ...geometry, ...imported.model.shapeParams });
  }, [imported, geometry, setGeometry]);

  // The dressed car is what the Solid view shows unless an imported model is drawn instead.
  const dressed = appearance !== null && view.bodyStyle === "solid" && !painted && !bodyId;

  // Desktop: buttons wrap. Phone: one row that scrolls sideways.
  const toolbarRow = compact ? "scroll-none flex max-w-full overflow-x-auto [&>*]:shrink-0" : "flex flex-wrap";
  const playbackButtons = (
    <>
      <Button variant="tool" size="sm" onClick={() => view.setCamera(view.camera.preset)} title="Reset camera (R)">
        Reset view {!compact && <Kbd>R</Kbd>}
      </Button>
      <Button variant="tool" size="sm" onClick={() => view.setPlaying(!view.playing)} disabled={!field} title="Start / stop airflow animation (Space)">
        {view.playing ? "Pause flow" : "Play flow"} {!compact && <Kbd>Space</Kbd>}
      </Button>
    </>
  );

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-bg [container-type:size]">
      <TunnelScene
        geometry={geometry}
        bodyId={bodyId}
        painted={painted}
        wrap={wrap}
        appearance={appearance}
        resultGeometry={result?.config.geometry ?? null}
        field={field}
        forces={result?.aero.forces ?? null}
        bodyStyle={view.bodyStyle}
        bodyOpacity={view.bodyOpacity}
        layers={view.layers}
        sliceAxis={view.sliceAxis}
        slicePosition={view.slicePosition}
        playing={view.playing}
        particleCount={particleCount}
        camera={view.camera}
        formatForce={formatForce}
      />

      {/*
        Top overlay, laid out in normal flow so nothing can cover anything else: the two toolbars sit
        side by side when there is room and wrap onto separate rows when there is not, and the status
        messages always start below them.
      */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-col gap-2 max-sm:inset-x-2 max-sm:top-2">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          {/* Visualisation modes and layers */}
          <div className="pointer-events-auto flex min-w-0 max-w-full flex-col items-start gap-2">
            <ButtonGroup className={toolbarRow} aria-label="Visualisation mode">
              {MODES.map((mode) => (
                <Button
                  key={mode.id}
                  variant="tool"
                  size="sm"
                  active={view.mode === mode.id}
                  disabled={!field && mode.id !== "solid" && mode.id !== "wireframe" && mode.id !== "transparent"}
                  onClick={() => view.setMode(mode.id)}
                >
                  {mode.label}
                </Button>
              ))}
              <span aria-hidden className="mx-1 my-1.5 w-px shrink-0 bg-line-strong" />
              <Button variant="tool" size="sm" active={layerMenuOpen} aria-expanded={layerMenuOpen} onClick={() => setLayerMenuOpen(!layerMenuOpen)}>
                Layers <Chevron open={layerMenuOpen} />
              </Button>
            </ButtonGroup>
            {layerMenuOpen && <LayerMenu />}
          </div>

          {/* Camera */}
          <div className={`pointer-events-auto ml-auto flex max-w-full gap-2 ${compact ? "min-w-0" : "flex-col items-end"}`}>
            <ButtonGroup className={compact ? toolbarRow : "flex flex-wrap justify-end"} aria-label="Camera view">
              {CAMERAS.map((camera) => (
                <Button
                  key={camera.id}
                  variant="tool"
                  size="sm"
                  onClick={() => view.setCamera(camera.id)}
                  title={camera.key ? `Shortcut: ${camera.key}` : undefined}
                >
                  {camera.label}
                  {camera.key && !compact && <Kbd>{camera.key}</Kbd>}
                </Button>
              ))}
              {compact && playbackButtons}
            </ButtonGroup>
            {!compact && (
              <ButtonGroup className="flex" aria-label="Camera and playback">
                {playbackButtons}
              </ButtonGroup>
            )}
          </div>
        </div>

        {/* Status */}
        <div className="flex w-[min(380px,100%)] flex-col items-center gap-2 self-center">
          <JobStatusCard />
          {stale && !running && (
            <div role="status" className={`${NOTICE} !border-warn/70 text-ink`}>
              <span className="mr-1 font-semibold text-warn">Stale.</span>
              Inputs changed since the last run. Results and flow field show the previous configuration — press Run.
            </div>
          )}
          {!field && !running && (
            <div className={`${NOTICE} text-ink-2`}>
              Geometry preview. No flow has been computed yet — press Run.
            </div>
          )}
          {imported && <ImportedNotice imported={imported} onRestore={restoreModelShape} />}
        </div>
      </div>

      {/* Legends and provenance */}
      {field && (
        <div
          className={`absolute bottom-3 left-3 flex max-w-[calc(100%-150px)] flex-col gap-2.5 rounded-2xl border border-line bg-panel/85 p-3.5 backdrop-blur-md max-sm:bottom-2 max-sm:left-2 ${
            // On a phone the notes scroll inside the card so they never cover more than part of the small viewport.
            compact ? "scroll-thin max-h-[42cqh] overflow-y-auto overscroll-contain" : "pointer-events-none"
          }`}
        >
          {showVelocityLegend && (
            <Legend title={`Flow speed · ${speedUnit.label}`} ticks={velocityTicks} />
          )}
          {showPressureLegend && (
            <Legend
              title="Pressure coefficient Cp · low → high"
              ticks={[PRESSURE_RANGE[0].toFixed(1), (PRESSURE_RANGE[0] / 2).toFixed(1), "0", (PRESSURE_RANGE[1] / 2).toFixed(1), PRESSURE_RANGE[1].toFixed(1)]}
            />
          )}
          <p className="max-w-[420px] text-[11px] leading-normal text-ink-3">
            <span className="font-semibold text-ink-2">Visualisation:</span> {field.provenance}
            {slowdown && (view.layers.airflow || view.layers.streamlines) ? ` Animation slowed ${slowdown.toFixed(0)}× relative to real time.` : ""}
            {dressed ? ` ${DETAIL_NOTE}` : ""}
          </p>
          {imported && <ImportedCaption imported={imported} onRestore={restoreModelShape} />}
        </div>
      )}
      {!field && (dressed || imported) && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[320px] rounded-2xl border border-line bg-panel/85 p-3.5 backdrop-blur-md max-sm:bottom-2 max-sm:left-2">
          {dressed && <p className="text-[11px] leading-normal text-ink-3">{DETAIL_NOTE}</p>}
          {imported && <ImportedCaption imported={imported} onRestore={restoreModelShape} />}
        </div>
      )}
      <div className="pointer-events-none absolute right-3 bottom-2 text-right text-[11px] leading-tight text-ink-3 max-sm:max-w-[104px] max-sm:text-[10px]">
        X longitudinal · Y lateral · Z vertical
      </div>
    </div>
  );
}
