"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ProfileDrawing } from "@/components/dashboard/ProfileDrawing";
import { ErrorBox } from "@/components/dashboard/ResultsPanel";
import { AppHeader } from "@/components/ui/AppHeader";
import { AppLink } from "@/components/ui/AppLink";
import { Button } from "@/components/ui/Button";
import { NumberInput } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Layout";
import { computeMetrics } from "@/lib/geometry/metrics";
import { buildBodyShape } from "@/lib/geometry/profile";
import { isGeometryValid } from "@/lib/geometry/validate";
import { deleteModel } from "@/lib/import/modelStore";
import { fetchVehicles, saveVehicle } from "@/lib/simulation/backendApi";
import { leavePage } from "@/lib/state/pageTransition";
import { isResultStale } from "@/lib/state/run";
import { useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";
import { currentVehicle, useSimStore } from "@/lib/state/simStore";
import type { ParamBasis, VehicleDefinition } from "@/lib/types";
import { formatWithUnit } from "@/lib/utils/units";
import { BUILT_IN_VEHICLES, REAL_CARS } from "@/lib/vehicle/library";

function VehicleCard({ vehicle, onOpen, onDelete }: { vehicle: VehicleDefinition; onOpen: () => void; onDelete?: () => void }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const metrics = useMemo(() => computeMetrics(buildBodyShape(vehicle.geometry)), [vehicle.geometry]);
  const powertrain = vehicle.powertrain;
  const rows: [string, string][] = [
    ["Mass", formatWithUnit(system, "mass", vehicle.mass)],
    ["Length", formatWithUnit(system, "length", metrics.length)],
    ["Width", formatWithUnit(system, "length", vehicle.geometry.width)],
    ["Height", formatWithUnit(system, "length", metrics.overallHeight)],
    ["Frontal area", `${formatWithUnit(system, "area", metrics.frontalArea)} (computed)`],
    ["Wheelbase", formatWithUnit(system, "length", vehicle.geometry.wheelbase)],
    ["Track width", formatWithUnit(system, "length", metrics.trackWidth)],
    ["Default Cd", vehicle.reference.cd.toFixed(2)],
    ["Default Cl", vehicle.reference.cl.toFixed(2)],
    [
      "Powertrain",
      `${powertrain.type === "EV" ? "Electric" : "ICE"} · ${formatWithUnit(system, "power", powertrain.peakPowerW)} · ${vehicle.drivetrain}`,
    ],
  ];
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">{vehicle.name}</h2>
        {vehicle.custom ? <Badge tone="accent">Custom</Badge> : <Badge>Generic class</Badge>}
      </div>
      <div className="border-b border-line bg-bg px-4 py-3">
        <ProfileDrawing className="h-[92px] w-full" ariaLabel={`Side profile of the ${vehicle.name}`} layers={[{ geometry: vehicle.geometry, color: "#aab2bd" }]} />
      </div>
      <p className="px-4 pt-2 text-xs leading-normal text-ink-2">{vehicle.description}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 py-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[13px] text-ink-3">{label}</dt>
            <dd className="num text-right text-[13px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line px-4 py-2">
        <span className="text-[11px] text-ink-3">Approximate reference values</span>
        <div className="flex gap-1.5">
          {onDelete && (
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={onOpen}>
            Open in simulator
          </Button>
        </div>
      </div>
    </article>
  );
}

const BASIS_ORDER: { id: ParamBasis; label: string }[] = [
  { id: "published", label: "published" },
  { id: "derived", label: "derived from published figures" },
  { id: "estimated", label: "estimated" },
  { id: "class", label: "generic class value" },
];

/** A production car: its published figures and sources, and how its look-alike was put together. */
function RealCarCard({ vehicle, onOpen }: { vehicle: VehicleDefinition; onOpen: () => void }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const info = vehicle.realCar!;
  const { published } = info;
  const metrics = useMemo(() => computeMetrics(buildBodyShape(vehicle.geometry)), [vehicle.geometry]);
  const powertrain = vehicle.powertrain;
  const length = (si: number) => formatWithUnit(system, "length", si);
  const counts = BASIS_ORDER.map(({ id, label }) => ({ label, count: Object.values(info.basis).filter((basis) => basis === id).length }));
  const rows: [string, string][] = [
    ["Published Cd", published.cd === null ? "none found" : published.cd.toFixed(3)],
    ["Length × width × height", `${length(published.length)} × ${length(published.width)} × ${length(published.height)}`],
    ["Wheelbase", length(published.wheelbase)],
    ["Ground clearance", published.groundClearance === null ? "not published" : length(published.groundClearance)],
    ["Tyres", published.tyres],
    ["Kerb mass", formatWithUnit(system, "mass", published.kerbMass)],
    [
      "Frontal area",
      published.frontalArea === null
        ? `not published (look-alike: ${formatWithUnit(system, "area", metrics.frontalArea)})`
        : `${formatWithUnit(system, "area", published.frontalArea)} (look-alike: ${formatWithUnit(system, "area", metrics.frontalArea)})`,
    ],
    ["Powertrain", `${powertrain.type === "EV" ? "Electric" : "ICE"} · ${formatWithUnit(system, "power", powertrain.peakPowerW)} · ${vehicle.drivetrain}`],
    ["Predicted from", `${info.anchorClassName} class · Cd ${vehicle.reference.cd.toFixed(2)}`],
  ];
  return (
    <article id={vehicle.id} className="flex scroll-mt-20 flex-col overflow-hidden rounded-2xl border border-line bg-panel target:border-data">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h3 className="min-w-0 text-[15px] font-semibold text-ink font-stretch-semi-expanded">
          {vehicle.name} <span className="num text-[13px] font-normal text-ink-3">{info.years}</span>
        </h3>
        <Badge tone="data">Look-alike</Badge>
      </div>
      <div className="border-b border-line bg-bg px-4 py-3">
        <ProfileDrawing className="h-[92px] w-full" ariaLabel={`Side profile of the ${vehicle.name} look-alike`} layers={[{ geometry: vehicle.geometry, color: "#aab2bd" }]} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 py-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[13px] text-ink-3">{label}</dt>
            <dd className="num text-right text-[13px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-line px-4 py-2 text-xs leading-normal text-ink-3">
        <p>{published.cdNote}</p>
        <p className="mt-1.5">
          Shape parameters: {counts.filter((entry) => entry.count > 0).map((entry) => `${entry.count} ${entry.label}`).join(", ")}.
        </p>
        {info.notes.length > 0 && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
            {info.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-ink-2">Sources</p>
        <ul className="list-disc space-y-0.5 pl-4">
          {info.sources.map((source) => (
            <li key={source.url}>
              <a className="hover:text-data hover:underline" href={source.url} target="_blank" rel="noreferrer">
                {source.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line px-4 py-2">
        <span className="text-[11px] text-ink-3">Simplified shape, not the manufacturer&apos;s surfaces</span>
        <Button size="sm" variant="primary" onClick={onOpen}>
          Open in simulator
        </Button>
      </div>
    </article>
  );
}

/** A vehicle made from an imported 3D model: where the model came from and what was measured from it. */
function ImportedCard({ vehicle, onOpen, onDelete }: { vehicle: VehicleDefinition; onOpen: () => void; onDelete: () => void }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const model = vehicle.importedModel!;
  const published = vehicle.realCar?.published ?? null;
  const rows: [string, string][] = [
    ["File", `${model.fileName} · ${model.triangles.toLocaleString("en-US")} triangles`],
    [model.measured.rearAttachment ? "Length of the body" : "Length", formatWithUnit(system, "length", model.measured.length)],
    ["Width, mirrors removed", formatWithUnit(system, "length", model.measured.width)],
    ["Height", formatWithUnit(system, "length", model.measured.height)],
    ["Wheels", model.measured.wheelsFound ? "found in the model" : "not found; class values"],
    ["Anchor class", `${model.anchorClassName} (Cd ${vehicle.reference.cd.toFixed(2)})`],
    ...(published ? ([["Published Cd", published.cd === null ? "not available" : `${published.cd.toFixed(3)} (comparison only)`]] as [string, string][]) : []),
  ];
  const credit = [model.source.title, model.source.author && `by ${model.source.author}`, model.source.licence].filter(Boolean).join(" · ");
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h3 className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">{vehicle.name}</h3>
        <Badge tone="accent">3D model</Badge>
      </div>
      <div className="border-b border-line bg-bg px-4 py-3">
        <ProfileDrawing className="h-[92px] w-full" ariaLabel={`Side profile fitted to ${vehicle.name}`} layers={[{ geometry: vehicle.geometry, color: "#aab2bd" }]} />
      </div>
      <p className="px-4 pt-2 text-xs leading-normal text-ink-2">
        Outline of the shape parameters fitted to the model. In the simulator the model itself is shown and its measured
        envelope is solved. Model accuracy is not verified.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 py-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[13px] text-ink-3">{label}</dt>
            <dd className="num text-right text-[13px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="px-4 pb-2 text-xs leading-normal text-ink-3">
        Source: {credit || "not recorded"}
        {/^https?:\/\//.test(model.source.url) && (
          <>
            {" · "}
            <a href={model.source.url} target="_blank" rel="noreferrer" className="text-ink-2 underline hover:text-ink">
              model page
            </a>
          </>
        )}
      </p>
      <div className="mt-auto flex items-center justify-end gap-1.5 border-t border-line px-4 py-2">
        <Button size="sm" variant="danger" onClick={onDelete}>
          Delete
        </Button>
        <Button size="sm" variant="primary" onClick={onOpen}>
          Open in simulator
        </Button>
      </div>
    </article>
  );
}

/** Form that turns the geometry currently in the simulator into a reusable custom vehicle. */
function SaveCustomVehicle() {
  const backendOnline = useBackendStore((state) => state.status === "online");
  const demoMode = useSettingsStore((state) => state.demoMode);
  const addCustomVehicle = useSimStore((state) => state.addCustomVehicle);
  const [name, setName] = useState("");
  const [cd, setCd] = useState(0.3);
  const [cl, setCl] = useState(0.1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  // Start from the latest fresh result if there is one, otherwise from the base vehicle's reference.
  useEffect(() => {
    const sim = useSimStore.getState();
    const fresh = sim.result && !isResultStale(sim.result) ? sim.result.aero.coefficients : null;
    const base = currentVehicle(sim).reference;
    setCd(Number((fresh?.cd ?? base.cd).toFixed(3)));
    setCl(Number((fresh?.cl ?? base.cl).toFixed(3)));
  }, []);

  const save = async () => {
    setError(null);
    setMessage(null);
    const sim = useSimStore.getState();
    if (!isGeometryValid(sim.geometry)) {
      setError({ code: "INVALID_GEOMETRY", message: "The geometry in the simulator is not valid; fix it there first." });
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError({ code: "NAME_REQUIRED", message: "Give the vehicle a name." });
      return;
    }
    const base = currentVehicle(sim);
    const vehicle: VehicleDefinition = {
      id: `custom-${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`,
      name: trimmed,
      description: `Custom vehicle derived from the ${base.name} class.`,
      reference: { cd, cl },
      ...sim.spec,
      geometry: { ...sim.geometry },
      powertrain: structuredClone(sim.powertrain),
      custom: true,
    };
    addCustomVehicle(vehicle);
    if (backendOnline && !demoMode) {
      try {
        await saveVehicle(vehicle);
        setMessage(`Saved "${trimmed}" in this browser and on the backend.`);
      } catch (failure) {
        setMessage(`Saved "${trimmed}" in this browser.`);
        setError({ code: "BACKEND_SAVE_FAILED", message: failure instanceof Error ? failure.message : "Could not store the vehicle on the backend." });
      }
    } else {
      setMessage(`Saved "${trimmed}" in this browser.`);
    }
    setName("");
  };

  return (
    <section className="rounded-2xl border border-line bg-panel p-5" aria-labelledby="custom-heading">
      <h2 id="custom-heading" className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">
        Save the simulator geometry as a custom vehicle
      </h2>
      <p className="mt-1 max-w-[90ch] text-xs leading-normal text-ink-3">
        A custom vehicle stores the current geometry, chassis and powertrain together with the reference coefficients you
        enter. Those reference values become the calibration anchor for later modifications, so use values you trust
        (for example from your own measurement or CFD). The defaults are the latest simulated values, or the base class
        reference.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label>
          <span className="label block">Name</span>
          <input
            className="mt-0.5 h-7 w-56 border border-line bg-bg px-1.5 text-[13px] text-ink focus:border-data"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Track-day coupe"
          />
        </label>
        <label>
          <span className="label block">Reference Cd</span>
          <span className="mt-0.5 block w-20">
            <NumberInput ariaLabel="Reference Cd" value={cd} decimals={3} min={0.1} max={0.9} step={0.005} onCommit={setCd} />
          </span>
        </label>
        <label>
          <span className="label block">Reference Cl</span>
          <span className="mt-0.5 block w-20">
            <NumberInput ariaLabel="Reference Cl" value={cl} decimals={3} min={-2} max={1} step={0.01} onCommit={setCl} />
          </span>
        </label>
        <Button variant="primary" onClick={() => void save()}>
          Save vehicle
        </Button>
      </div>
      {message && <p className="mt-2 text-xs text-ok">{message}</p>}
      {error && (
        <div className="mt-2 max-w-[520px]">
          <ErrorBox code={error.code} message={error.message} />
        </div>
      )}
    </section>
  );
}

export function LibraryWorkspace() {
  const router = useRouter();
  const customVehicles = useSimStore((state) => state.customVehicles);
  const loadVehicle = useSimStore((state) => state.loadVehicle);
  const addCustomVehicle = useSimStore((state) => state.addCustomVehicle);
  const removeCustomVehicle = useSimStore((state) => state.removeCustomVehicle);
  const backendOnline = useBackendStore((state) => state.status === "online");
  const demoMode = useSettingsStore((state) => state.demoMode);

  // Custom vehicles stored on the backend are merged into the local list.
  useEffect(() => {
    if (!backendOnline || demoMode) return;
    fetchVehicles()
      .then((vehicles) => {
        const known = new Set(useSimStore.getState().customVehicles.map((vehicle) => vehicle.id));
        for (const vehicle of vehicles) {
          if (vehicle.custom && !known.has(vehicle.id)) addCustomVehicle(vehicle);
        }
      })
      .catch(() => {
        // The library works from local data when the backend list is unavailable.
      });
  }, [backendOnline, demoMode, addCustomVehicle]);

  const importedVehicles = customVehicles.filter((vehicle) => vehicle.importedModel);
  const plainCustomVehicles = customVehicles.filter((vehicle) => !vehicle.importedModel);

  const open = (vehicle: VehicleDefinition) => {
    loadVehicle(vehicle);
    leavePage((to) => router.push(to), "/simulator");
  };

  // The cards are rendered in the browser only, after the page's own scroll-to-anchor has run.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div className="grid-backdrop flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-5">
        <h1 className="text-[clamp(26px,2.6vw,34px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">Vehicle library</h1>
        <h2 className="mt-8 text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink font-stretch-expanded">Generic classes</h2>
        <p className="mt-2 max-w-[84ch] text-sm leading-relaxed text-ink-2">
          Six simplified, generic road-car classes. They are not models of any manufacturer&apos;s vehicle. Every figure is
          an approximate reference value typical of the class; the default Cd and Cl anchor the simplified aerodynamic
          models, and frontal area is computed from the generated geometry.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {BUILT_IN_VEHICLES.map((vehicle) => (
            <VehicleCard key={vehicle.id} vehicle={vehicle} onOpen={() => open(vehicle)} />
          ))}
        </div>

        <h2 className="mt-14 text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink font-stretch-expanded">Production cars as look-alikes</h2>
        <p className="mt-2 max-w-[84ch] text-sm leading-relaxed text-ink-2">
          {REAL_CARS.length} production cars, each rebuilt from the simulator&apos;s 31 shape parameters. Published dimensions
          are used where they exist; rake angles, hood and deck lengths, tapers and floor detail are not published and are
          estimated. A look-alike is a simplified shape, not the manufacturer&apos;s surfaces, and what the simulator reports
          for it is not a measurement of the real car. The published drag coefficient is shown for comparison only: the
          models predict each car from a generic class and never read it. See{" "}
          <AppLink href="/validation" className="text-ink-2 underline hover:text-ink">
            Validation
          </AppLink>{" "}
          for how the predictions compare.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {REAL_CARS.map((vehicle) => (
            <RealCarCard key={vehicle.id} vehicle={vehicle} onOpen={() => open(vehicle)} />
          ))}
        </div>

        <h2 id="imported" className="mt-14 scroll-mt-20 text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink font-stretch-expanded">Imported 3D models</h2>
        <p className="mt-2 max-w-[84ch] text-sm leading-relaxed text-ink-2">
          A 3D model file of a car (glTF, OBJ or STL) is shown in the tunnel with its own paint and materials, and Modes A
          and B work on its measured outer envelope instead of the 31-parameter shape. Manufacturers do not publish their
          surfaces: downloadable models are made by artists, their accuracy is unknown, and each comes with its own
          licence. Files are stored in this browser only.
        </p>
        <div className="mt-3">
          <AppLink
            href="/import"
            className="inline-flex h-8 items-center rounded-lg border border-accent bg-accent px-4 text-[13px] font-semibold text-accent-ink hover:brightness-110"
          >
            Import a 3D model…
          </AppLink>
        </div>
        {importedVehicles.length > 0 && (
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {importedVehicles.map((vehicle) => (
              <ImportedCard
                key={vehicle.id}
                vehicle={vehicle}
                onOpen={() => open(vehicle)}
                onDelete={() => {
                  removeCustomVehicle(vehicle.id);
                  void deleteModel(vehicle.importedModel!.bodyId).catch(() => {
                    // The vehicle is gone from the library either way; leftover files only take up storage.
                  });
                }}
              />
            ))}
          </div>
        )}

        <h2 className="mt-14 text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink font-stretch-expanded">Custom vehicles</h2>
        <div className="mt-3">
          <SaveCustomVehicle />
        </div>
        {plainCustomVehicles.length > 0 && (
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {plainCustomVehicles.map((vehicle) => (
              <VehicleCard key={vehicle.id} vehicle={vehicle} onOpen={() => open(vehicle)} onDelete={() => removeCustomVehicle(vehicle.id)} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
