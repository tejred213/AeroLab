"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { computeMetrics } from "@/lib/geometry/metrics";
import { buildBodyShape } from "@/lib/geometry/profile";
import { makePerformanceInput, vehicleSpecOf } from "@/lib/simulation/config";
import { useSettingsStore } from "@/lib/state/settingsStore";
import type { PerformanceResult, SimulationResult, VehicleDefinition } from "@/lib/types";
import { formatNumber, formatWithUnit, unitOf } from "@/lib/utils/units";
import { resistances } from "@/lib/vehicle/performance";

/**
 * How long a car stays in the scene, and how long a group of figures stays up, ms. The two take
 * turns half a period apart, so something changes every ten seconds and never both at once.
 */
const TURN_MS = 20_000;
const TICK_MS = 200;

interface Figure {
  label: string;
  value: ReactNode;
}

interface FigureGroup {
  id: string;
  title: string;
  /** Where the figures come from, in a few words. */
  basis: string;
  figures: Figure[];
}

interface LandingReadoutProps {
  vehicle: VehicleDefinition;
  /** Result of the run that produced the flow field on screen; null until it arrives. */
  result: SimulationResult | null;
  performance: PerformanceResult | null;
  /** The run failed: only the figures that need no simulation are shown. */
  failed: boolean;
  /** False while the scene is off screen; nothing changes by itself then. */
  active: boolean;
  /** Place of the car among those that take turns in the scene. */
  position: number;
  count: number;
  /** The next car's run is ready, so the scene can move on to it. */
  nextReady: boolean;
  /** Show another car: +1 the next, -1 the previous. */
  onStep: (delta: number) => void;
  /** Open the simulator with the car shown. */
  onOpen: () => void;
}

const ICON_BUTTON = "flex h-7 w-7 items-center justify-center text-ink-3 transition-colors hover:bg-raise hover:text-ink";

function scientific(value: number): ReactNode {
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  return (
    <>
      {(value / 10 ** exponent).toFixed(2)} × 10<sup>{exponent}</sup>
    </>
  );
}

/**
 * Figures for the car shown on the landing page, beside the scene. One group is shown at a time;
 * the groups take turns, and so do the cars. Every number comes from the same models the simulator
 * uses, for this vehicle and the run behind the picture; nothing here is typed in.
 */
export function LandingReadout({ vehicle, result, performance, failed, active, position, count, nextReady, onStep, onOpen }: LandingReadoutProps) {
  const system = useSettingsStore((state) => state.unitSystem);

  const groups = useMemo<FigureGroup[]>(() => {
    const list: FigureGroup[] = [];
    const speedUnit = unitOf(system, "speed");
    const kmh = (value: number) => `${speedUnit.toDisplay(value / 3.6).toFixed(0)} ${speedUnit.label}`;

    if (result) {
      const { aero, config } = result;
      const c = aero.coefficients;
      const downforce = aero.forces.lift < 0;
      list.push({
        id: "aero",
        title: "Aerodynamics",
        basis: `Mode A estimate at ${formatWithUnit(system, "speed", config.speed)}`,
        figures: [
          { label: "Drag coefficient (Cd)", value: `${formatNumber(c.cd, 3)} ± ${formatNumber(aero.uncertainty.cd, 3)}` },
          { label: "Drag", value: formatWithUnit(system, "force", aero.forces.drag) },
          { label: downforce ? "Downforce" : "Lift", value: formatWithUnit(system, "force", Math.abs(aero.forces.lift)) },
          { label: "Drag area (CdA)", value: `${formatNumber(c.cd * c.frontalArea, 3)} m²` },
        ],
      });
    }

    const metrics = result?.aero.metrics ?? computeMetrics(buildBodyShape(vehicle.geometry));
    list.push({
      id: "shape",
      title: "Shape",
      basis: "From the class's shape parameters",
      figures: [
        { label: "Length", value: formatWithUnit(system, "length", metrics.length) },
        { label: "Width", value: formatWithUnit(system, "length", vehicle.geometry.width) },
        { label: "Height", value: formatWithUnit(system, "length", metrics.overallHeight) },
        { label: "Frontal area", value: formatWithUnit(system, "area", metrics.frontalArea) },
      ],
    });

    if (result && performance) {
      const { aero, config } = result;
      const input = makePerformanceInput(
        vehicleSpecOf(vehicle),
        vehicle.powertrain,
        config.geometry,
        aero.coefficients,
        aero.air.density,
        config.environment,
        config.speed,
      );
      const cruise = 100 / 3.6;
      const sprint = performance.accelTimes.find((entry) => entry.target === 100)?.time;
      list.push({
        id: "performance",
        title: "Performance",
        basis: `Performance model, ${formatWithUnit(system, "mass", vehicle.mass)}`,
        figures: [
          { label: "Top speed", value: formatWithUnit(system, "speed", performance.topSpeed) },
          { label: `0–${kmh(100)}`, value: sprint === null || sprint === undefined ? "not reached" : `${sprint.toFixed(1)} s` },
          { label: `Power to hold ${kmh(100)}`, value: formatWithUnit(system, "power", resistances(input, cruise).total * cruise) },
          { label: "Peak power", value: formatWithUnit(system, "power", vehicle.powertrain.peakPowerW) },
        ],
      });
    }

    if (result) {
      const { aero, config } = result;
      list.push({
        id: "flow",
        title: "Flow conditions",
        basis: "Standard air, no wind",
        figures: [
          { label: "Air speed", value: formatWithUnit(system, "speed", config.speed) },
          { label: "Air density", value: formatWithUnit(system, "density", aero.air.density) },
          { label: "Dynamic pressure", value: formatWithUnit("si", "pressure", aero.forces.dynamicPressure) },
          { label: "Reynolds number", value: scientific(aero.air.reynolds) },
        ],
      });
    }
    return list;
  }, [vehicle, result, performance, system]);

  const [groupId, setGroupId] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [held, setHeld] = useState(false);
  // Time the group on show and the car on show have each had, and how long this group's turn is.
  // The first group gets half a turn, which puts the two cycles half a period apart.
  const groupElapsed = useRef(0);
  const groupTurn = useRef(TURN_MS / 2);
  const carElapsed = useRef(0);
  const fill = useRef<HTMLSpanElement>(null);

  // People who ask for reduced motion get a scene and figures that stay put until they choose.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setStopped(true);
  }, []);

  const index = Math.max(groups.findIndex((group) => group.id === groupId), 0);
  const group = groups[index];
  const turning = !stopped && !held && active;

  const show = (id: string) => {
    groupElapsed.current = 0;
    groupTurn.current = TURN_MS;
    setGroupId(id);
  };
  const step = (delta: number) => {
    carElapsed.current = 0;
    onStep(delta);
  };

  useEffect(() => {
    if (!turning) return;
    let last = window.performance.now();
    const timer = window.setInterval(() => {
      const now = window.performance.now();
      // A background tab slows timers down; never count more than a couple of ticks at once.
      const passed = Math.min(now - last, 2 * TICK_MS);
      last = now;
      if (groups.length > 1) {
        groupElapsed.current += passed;
        if (groupElapsed.current >= groupTurn.current) {
          groupElapsed.current = 0;
          groupTurn.current = TURN_MS;
          setGroupId(groups[(index + 1) % groups.length].id);
        }
        if (fill.current) fill.current.style.transform = `scaleX(${Math.min(groupElapsed.current / groupTurn.current, 1)})`;
      }
      if (count > 1) {
        carElapsed.current += passed;
        // A car whose run is still being computed is waited for rather than shown without its flow.
        if (carElapsed.current >= TURN_MS && nextReady) {
          carElapsed.current = 0;
          onStep(1);
        }
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [turning, groups, index, count, nextReady, onStep]);

  const waiting = !result && !failed;
  return (
    <aside
      className="landing-readout"
      aria-label={`Figures for the ${vehicle.name} shown`}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHeld(true);
      }}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="landing-readout-car">
        <div className="landing-readout-name min-w-0">
          <span className="truncate text-[15px] font-semibold text-ink font-stretch-semi-expanded">{vehicle.name}</span>
          <span className="num shrink-0 text-xs text-ink-3">
            <span className="landing-readout-kind">Generic class, </span>
            {position + 1} of {count}
          </span>
        </div>
        <div className="-mr-1.5 flex shrink-0 items-center">
          {count > 1 && (
            <>
              <button type="button" aria-label="Show the previous car" title="Previous car" onClick={() => step(-1)} className={ICON_BUTTON}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M6.5 1.5 3 5l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" aria-label="Show the next car" title="Next car" onClick={() => step(1)} className={ICON_BUTTON}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            aria-pressed={stopped}
            aria-label={stopped ? "Let the car and the figures change again" : "Stop the car and the figures changing"}
            title={stopped ? "Resume" : "Pause"}
            onClick={() => setStopped(!stopped)}
            className={ICON_BUTTON}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              {stopped ? <path d="M2 1.2v7.6a.4.4 0 0 0 .6.35l6.3-3.8a.4.4 0 0 0 0-.7L2.6.85a.4.4 0 0 0-.6.35Z" fill="currentColor" /> : <path d="M2.5 1v8M7.5 1v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
            </svg>
          </button>
        </div>
      </div>

      <div className="landing-readout-heading min-w-0">
        <span className="shrink-0 text-[13px] font-semibold text-ink">{waiting ? "Computing the figures…" : group.title}</span>
        {!waiting && <span className="truncate text-xs text-ink-3">{group.basis}</span>}
      </div>

      {/* Keyed by car and group, so each change plays the short entrance once. */}
      <dl key={waiting ? `${vehicle.id}:waiting` : `${vehicle.id}:${group.id}`} className="landing-readout-figures">
        {(waiting ? [] : group.figures).map((figure) => (
          <div key={figure.label}>
            <dt className="truncate text-xs text-ink-3">{figure.label}</dt>
            <dd className="num landing-readout-value">{figure.value}</dd>
          </div>
        ))}
      </dl>

      <div className="landing-readout-foot">
        {groups.length > 1 && (
          <div className="landing-readout-steps" role="group" aria-label="Which figures are shown">
            {groups.map((entry, place) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={place === index}
                aria-label={`Show ${entry.title.toLowerCase()}`}
                title={entry.title}
                onClick={() => show(entry.id)}
              >
                <span>
                  {/* A fresh element for each turn, so the bar starts empty instead of running backwards. */}
                  {place === index && (
                    <span key={`${entry.id}:${stopped}`} ref={fill} style={{ transform: `scaleX(${stopped ? 1 : Math.min(groupElapsed.current / groupTurn.current, 1)})` }} />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="landing-readout-open" onClick={onOpen}>
          Open in simulator
        </button>
      </div>
    </aside>
  );
}
