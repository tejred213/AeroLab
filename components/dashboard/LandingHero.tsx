"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LandingReadout } from "@/components/dashboard/LandingReadout";
import { STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import { performanceLocal, simulateLocal } from "@/lib/simulation/client";
import { makeConfig, makePerformanceInput, vehicleSpecOf } from "@/lib/simulation/config";
import type { FlowField } from "@/lib/simulation/field";
import { leaveLanding, reportShownVehicle } from "@/lib/state/pageTransition";
import type { FlowLayers } from "@/lib/state/viewStore";
import type { PerformanceResult, SimulationResult, VehicleDefinition } from "@/lib/types";
import { appearanceFor, type CarAppearance } from "@/lib/vehicle/appearance";
import { BUILT_IN_VEHICLES } from "@/lib/vehicle/library";

const TunnelScene = dynamic(() => import("@/components/3d/TunnelScene").then((module) => module.TunnelScene), {
  ssr: false,
});

/** The generic classes take turns in the scene, starting with the fastback. */
const FIRST = Math.max(BUILT_IN_VEHICLES.findIndex((vehicle) => vehicle.id === "fastback"), 0);
const CARS: VehicleDefinition[] = [...BUILT_IN_VEHICLES.slice(FIRST), ...BUILT_IN_VEHICLES.slice(0, FIRST)];
// One dark paint for all of them, so each reads against the white backdrop and only the shape changes. Appearance only.
const LOOKS = new Map<string, CarAppearance>(
  CARS.map((vehicle) => [vehicle.id, { ...appearanceFor(vehicle), paint: "#2e343b", metallic: 0.75, rimColor: "#c3c8ce" }]),
);
/** Air speed of every run on this page, m/s. */
const TEST_SPEED = 40;
/** How long the scene is faded out while one car is exchanged for the next, ms (matches the CSS). */
const VEIL_MS = 240;

const LAYERS: FlowLayers = {
  airflow: true,
  streamlines: false,
  velocity: false,
  pressure: false,
  wake: false,
  separation: false,
  forces: false,
};
const CAMERA = { preset: "perspective" as const, nonce: 0 };
const formatForce = (newton: number) => `${newton.toFixed(0)} N`;

/** What has been computed for one car: its run, and the performance figures once they follow. */
interface CarRun {
  field: FlowField | null;
  result: SimulationResult;
  performance: PerformanceResult | null;
}

/**
 * The landing page's scene: a slowly rotating generic car on a white backdrop, with tracer particles
 * following a solved flow field. The generic classes take turns. The caption states what the picture
 * is; the readout beside the car names the car and gives the figures of the run on screen.
 */
export function LandingHero() {
  const [shown, setShown] = useState(0);
  const [veiled, setVeiled] = useState(false);
  const [runs, setRuns] = useState<Record<string, CarRun>>({});
  const [failures, setFailures] = useState<Record<string, true>>({});
  const requested = useRef(new Set<string>());
  // The car asked for last, which `shown` reaches once the scene has faded out.
  const wanted = useRef(0);
  const exchange = useRef<number | null>(null);
  const mounted = useRef(true);
  const scene = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (exchange.current !== null) window.clearTimeout(exchange.current);
    };
  }, []);

  // Nothing is drawn once the scene has scrolled out of view.
  useEffect(() => {
    const element = scene.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Runs the models for a car once; the worker takes the requests in the order they are made. */
  const prepare = useCallback((vehicle: VehicleDefinition) => {
    if (requested.current.has(vehicle.id)) return;
    requested.current.add(vehicle.id);
    const config = makeConfig(vehicle, vehicle.geometry, STANDARD_ENVIRONMENT, TEST_SPEED, "analytical", "coarse");
    simulateLocal(config, true)
      .then((run) => {
        if (!mounted.current) return;
        setRuns((current) => ({ ...current, [vehicle.id]: { field: run.field, result: run.result, performance: null } }));
        const { aero } = run.result;
        // The readout's performance figures; the scene does not wait for them.
        performanceLocal(
          makePerformanceInput(vehicleSpecOf(vehicle), vehicle.powertrain, config.geometry, aero.coefficients, aero.air.density, config.environment, config.speed),
        )
          .then((performance) => {
            if (mounted.current) setRuns((current) => ({ ...current, [vehicle.id]: { ...current[vehicle.id], performance } }));
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (mounted.current) setFailures((current) => ({ ...current, [vehicle.id]: true }));
      });
  }, []);

  // The car on show, and the one after it so that it is ready when its turn comes.
  useEffect(() => {
    prepare(CARS[shown]);
    prepare(CARS[(shown + 1) % CARS.length]);
  }, [shown, prepare]);

  const step = useCallback((delta: number) => {
    wanted.current = (wanted.current + delta + CARS.length) % CARS.length;
    if (exchange.current !== null) window.clearTimeout(exchange.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(wanted.current);
      return;
    }
    // Fade the scene out, exchange the car and its flow field together, fade back in.
    setVeiled(true);
    exchange.current = window.setTimeout(() => {
      exchange.current = null;
      setShown(wanted.current);
      setVeiled(false);
    }, VEIL_MS);
  }, []);

  const vehicle = CARS[shown];
  // Links into the simulator can then open it with the car that was on screen.
  useEffect(() => reportShownVehicle(vehicle.id), [vehicle.id]);
  const router = useRouter();
  const openInSimulator = useCallback(() => leaveLanding((href) => router.push(href), "/simulator", { vehicle: "shown" }), [router]);
  const run = runs[vehicle.id] ?? null;
  const failed = failures[vehicle.id] === true;
  const field = run?.field ?? null;
  const next = CARS[(shown + 1) % CARS.length];

  return (
    <>
      <div
        ref={scene}
        className="landing-scene"
        data-veiled={veiled}
        role="img"
        aria-label={`The ${vehicle.name}, a generic class of car, turning slowly while streaks of air flow around it`}
      >
        <TunnelScene
          geometry={vehicle.geometry}
          appearance={LOOKS.get(vehicle.id)}
          resultGeometry={field ? vehicle.geometry : null}
          field={field}
          forces={null}
          bodyStyle="solid"
          bodyOpacity={1}
          layers={LAYERS}
          sliceAxis="y"
          slicePosition={0}
          playing
          particleCount={2000}
          camera={CAMERA}
          formatForce={formatForce}
          autoRotate
          showLabels={false}
          showGizmo={false}
          enableZoom={false}
          backdrop="studio"
          cameraDistance={1.42}
          suspended={!onScreen}
        />
      </div>
      <p className="landing-caption">
        {field
          ? "The streaks follow a reduced-order potential-flow field (not CFD), computed in your browser; they are darker where the air is faster. Glass, door lines, lights and paint are drawn only."
          : failed
            ? "The flow field could not be computed in this browser; showing the geometry only."
            : "Computing the reduced-order flow field…"}
      </p>
      <LandingReadout
        vehicle={vehicle}
        result={run?.result ?? null}
        performance={run?.performance ?? null}
        failed={failed}
        active={onScreen}
        position={shown}
        count={CARS.length}
        nextReady={runs[next.id] !== undefined || failures[next.id] === true}
        onStep={step}
        onOpen={openInSimulator}
      />
    </>
  );
}
