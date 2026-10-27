"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBox } from "@/components/dashboard/ResultsPanel";
import { AppHeader } from "@/components/ui/AppHeader";
import { AppLink } from "@/components/ui/AppLink";
import { Button } from "@/components/ui/Button";
import { Checkbox, NumberInput, Select } from "@/components/ui/Field";
import { bounds, guessOrientation, type Orientation, orientationMatrix, SHAPE_PARAMS } from "@/lib/geometry/meshImport";
import { applyExclusions, expandFiles, extractTriangles, type LoadedModel, type ModelFile, parseModel } from "@/lib/import/modelFiles";
import { saveModel } from "@/lib/import/modelStore";
import { measureLocal } from "@/lib/simulation/client";
import { vehicleSpecOf } from "@/lib/simulation/config";
import type { MeasureResult } from "@/lib/simulation/worker";
import { leavePage } from "@/lib/state/pageTransition";
import { useSimStore } from "@/lib/state/simStore";
import type { CameraPreset } from "@/lib/state/viewStore";
import type { ParamId, VehicleDefinition } from "@/lib/types";
import { BUILT_IN_VEHICLES, getBuiltInVehicle, REAL_CARS } from "@/lib/vehicle/library";

const ModelPreview = dynamic(() => import("@/components/import/ModelPreview"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-[13px] text-ink-3">Loading 3D view…</div>,
});

const SAMPLE_URL = "/cars/sample-fastback.glb";
/** How the model is brought to real size: by a known wheelbase, a known overall length, or not at all (metres). */
type ScaleMode = "wheelbase" | "length" | "none";
const AXES = ["X", "Y", "Z"];
const NONE = "none";
/** Plausible overall length of a car, m: a file inside this range is taken to be in metres. */
const CAR_LENGTH: [number, number] = [2.4, 6.6];

interface Loaded {
  files: ModelFile[];
  model: LoadedModel;
}

function millimetres(value: number): string {
  return `${Math.round(value * 1000)} mm`;
}

function percent(value: number, reference: number): string {
  const difference = (value / reference - 1) * 100;
  return `${difference >= 0 ? "+" : ""}${difference.toFixed(1)} %`;
}

const inputClass = "h-8 w-full border border-line-strong bg-bg px-2 text-[13px] text-ink outline-none focus:border-accent";

export function ImportWorkspace() {
  const router = useRouter();
  const addCustomVehicle = useSimStore((state) => state.addCustomVehicle);
  const loadVehicle = useSimStore((state) => state.loadVehicle);
  const fileInput = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [positions, setPositions] = useState<Float32Array | null>(null);
  const [orientation, setOrientation] = useState<Orientation>({ upAxis: 1, lengthAxis: 2, reverse: false });
  const [scaleMode, setScaleMode] = useState<ScaleMode>("none");
  const [targetLength, setTargetLength] = useState(4.5);
  const [targetWheelbase, setTargetWheelbase] = useState(2.8);
  const [localModels, setLocalModels] = useState<{ name: string; size: number }[]>([]);
  const [linkedCarId, setLinkedCarId] = useState<string>(NONE);
  const [anchorClassId, setAnchorClassId] = useState<string>("sedan");
  const [name, setName] = useState("");
  const [source, setSource] = useState({ title: "", author: "", url: "", licence: "" });
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [measured, setMeasured] = useState<(MeasureResult & { bodyId: string }) | null>(null);
  const [showModel, setShowModel] = useState(true);
  const [camera, setCamera] = useState<{ preset: CameraPreset; nonce: number }>({ preset: "three-quarter", nonce: 0 });

  const linkedCar = linkedCarId === NONE ? null : getBuiltInVehicle(linkedCarId);

  /** Reads a set of files, proposes an orientation and a scale. */
  const open = useCallback(async (files: File[], sample = false) => {
    setError(null);
    setMeasured(null);
    setBusy("Reading the model…");
    try {
      const modelFiles = await expandFiles(files);
      const model = await parseModel(modelFiles);
      const sheets = new Set(model.parts.filter((part) => part.sheet).map((part) => part.id));
      applyExclusions(model.scene, sheets);
      const soup = extractTriangles(model.scene, sheets);
      const guess = guessOrientation(soup, model.yUp);
      const box = bounds(soup);
      const fileLength = box.max[guess.lengthAxis] - box.min[guess.lengthAxis];
      setLoaded({ files: modelFiles, model });
      setExcluded(sheets);
      setPositions(soup);
      setOrientation(guess);
      setScaleMode(fileLength < CAR_LENGTH[0] || fileLength > CAR_LENGTH[1] ? "length" : "none");
      setLinkedCarId(NONE);
      setRightsConfirmed(sample);
      if (sample) {
        setName("Sample: generic fastback (re-imported)");
        setAnchorClassId("fastback");
        setSource({ title: "AeroLab sample model", author: "AeroLab (generated)", url: "", licence: "Part of this project; not a real car" });
      } else {
        // Model sites write the credit into the file; it is offered for checking, not taken on trust.
        setName(model.credit?.title || model.fileName.replace(/\.[a-z0-9]+$/i, ""));
        setSource(model.credit ?? { title: "", author: "", url: "", licence: "" });
      }
    } catch (problem) {
      setLoaded(null);
      setPositions(null);
      setError(problem instanceof Error ? problem.message : "The model could not be read.");
    } finally {
      setBusy(null);
    }
  }, []);

  const openSample = async () => {
    setBusy("Loading the sample…");
    try {
      const response = await fetch(SAMPLE_URL);
      if (!response.ok) throw new Error(`The sample model is missing (${response.status}).`);
      await open([new File([await response.blob()], "sample-fastback.glb")], true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The sample could not be loaded.");
      setBusy(null);
    }
  };

  // Model files placed in the project's public/cars folder can be loaded without the file picker.
  useEffect(() => {
    fetch("/api/local-models")
      .then((response) => (response.ok ? response.json() : { models: [] }))
      .then((data: { models?: { name: string; size: number }[] }) => setLocalModels(data.models ?? []))
      .catch(() => setLocalModels([]));
  }, []);

  const openLocal = async (fileName: string) => {
    setBusy(`Loading ${fileName}…`);
    try {
      const response = await fetch(`/cars/${encodeURIComponent(fileName)}`);
      if (!response.ok) throw new Error(`${fileName} could not be read (${response.status}).`);
      await open([new File([await response.blob()], fileName)]);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The model could not be loaded.");
      setBusy(null);
    }
  };

  const togglePart = (id: string) => {
    if (!loaded) return;
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    applyExclusions(loaded.model.scene, next);
    setExcluded(next);
    setPositions(extractTriangles(loaded.model.scene, next));
    setMeasured(null);
  };

  // Choosing a production car supplies its published length and its class.
  const chooseLinkedCar = (id: string) => {
    setLinkedCarId(id);
    setMeasured(null);
    if (id === NONE) return;
    const car = getBuiltInVehicle(id);
    if (car.realCar) {
      setTargetLength(car.realCar.published.length);
      setTargetWheelbase(car.realCar.published.wheelbase);
      // The wheelbase is the safer reference: bumpers, a rear-mounted spare wheel or a tow bar do not change it.
      setScaleMode("wheelbase");
      setAnchorClassId(car.realCar.anchorClassId);
      if (!name || name === loaded?.model.fileName.replace(/\.[a-z0-9]+$/i, "")) setName(`${car.name} (3D model)`);
    }
  };

  const box = useMemo(() => (positions && positions.length > 0 ? bounds(positions) : null), [positions]);
  const placement = useMemo(() => {
    if (measured) return { matrix: measured.matrix, scale: measured.scale, ...measured.box };
    if (!box) return null;
    try {
      // Scaling by wheelbase needs the wheels, which are only known after measuring: until then the model is
      // shown at a provisional size.
      const length = scaleMode === "none" ? undefined : scaleMode === "length" ? targetLength : (linkedCar?.realCar?.published.length ?? 4.5);
      return orientationMatrix(box, orientation, length);
    } catch {
      return null;
    }
  }, [measured, box, orientation, scaleMode, targetLength, linkedCar]);

  const changeOrientation = (next: Orientation) => {
    setOrientation(next);
    setMeasured(null);
  };
  // Any change to what is measured makes an earlier measurement out of date.
  useEffect(() => setMeasured(null), [scaleMode, targetLength, targetWheelbase, anchorClassId]);

  const plausible = placement !== null && (scaleMode === "wheelbase" || (placement.length >= CAR_LENGTH[0] && placement.length <= CAR_LENGTH[1]));

  const measure = async () => {
    if (!positions || !placement) return;
    setError(null);
    setBusy("Measuring the model…");
    try {
      const bodyId = `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await measureLocal({
        bodyId,
        // The worker takes ownership of the buffer it is sent.
        positions: positions.slice(),
        orientation,
        targetLength: scaleMode === "length" ? targetLength : undefined,
        targetWheelbase: scaleMode === "wheelbase" ? targetWheelbase : undefined,
        // What a surface cannot tell (floor, wheel exposure) comes from the look-alike of the same car when
        // there is one, otherwise from the generic class.
        anchor: (linkedCar ?? getBuiltInVehicle(anchorClassId)).geometry,
      });
      if (linkedCar?.realCar) {
        for (const id of Object.keys(result.fitted.basis) as ParamId[]) {
          if (result.fitted.basis[id] !== "measured") result.fitted.basis[id] = linkedCar.realCar.basis[id];
        }
      }
      setMeasured({ ...result, bodyId });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The model could not be measured.");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!loaded || !measured) return;
    setBusy("Saving…");
    setError(null);
    try {
      const anchor = getBuiltInVehicle(anchorClassId);
      // Mass, chassis and powertrain cannot be read from a surface: they come from the linked car or the class.
      const donor = linkedCar ?? anchor;
      const { geometry, basis } = measured.fitted;
      const { measured: model } = measured;
      const vehicle: VehicleDefinition = {
        ...vehicleSpecOf(donor),
        id: `imported-${measured.bodyId}`,
        name: name.trim() || "Imported 3D model",
        description:
          `Imported 3D model (${loaded.model.fileName}). The solver uses its outer envelope; shape parameters are fitted to it. ` +
          `Anchored to the generic ${anchor.name.toLowerCase()} class. The accuracy of the model itself is not verified.`,
        reference: { ...anchor.reference },
        geometry,
        referenceGeometry: { ...anchor.geometry },
        powertrain: structuredClone(donor.powertrain),
        custom: true,
        realCar: linkedCar?.realCar
          ? { ...linkedCar.realCar, anchorClassId: anchor.id, anchorClassName: anchor.name, basis }
          : undefined,
        importedModel: {
          bodyId: measured.bodyId,
          fileName: loaded.model.fileName,
          triangles: model.triangles,
          matrix: measured.matrix,
          scale: measured.scale,
          excludedParts: [...excluded],
          resolution: model.resolution,
          rideHeight: model.rideHeight,
          measured: {
            length: model.length,
            width: model.width,
            height: model.height,
            silhouetteArea: model.silhouetteArea,
            wheelsFound: model.wheels !== null,
            rearAttachment: model.rearAttachment,
          },
          shapeParams: Object.fromEntries(SHAPE_PARAMS.map((param) => [param, geometry[param]])) as Partial<Record<ParamId, number>>,
          anchorClassId: anchor.id,
          anchorClassName: anchor.name,
          linkedCarId: linkedCar?.id,
          source: { ...source },
          basis,
          importedAt: Date.now(),
        },
      };
      await saveModel(measured.bodyId, loaded.files, model.body, loaded.model.scene);
      addCustomVehicle(vehicle);
      loadVehicle(vehicle);
      leavePage((to) => router.push(to), "/simulator");
    } catch (problem) {
      setError(problem instanceof Error ? `The model could not be saved: ${problem.message}` : "The model could not be saved.");
      setBusy(null);
    }
  };

  const published = linkedCar?.realCar?.published ?? null;
  const wheels = measured?.measured.wheels ?? null;
  const sortedParts = useMemo(() => (loaded ? [...loaded.model.parts].sort((a, b) => b.triangles - a.triangles) : []), [loaded]);

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-ink">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-[clamp(26px,2.6vw,34px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">Import a 3D model of a car</h1>
          <AppLink href="/library" className="text-[13px] text-accent underline underline-offset-2">
            Back to the library
          </AppLink>
        </div>
        <p className="mt-1 max-w-[900px] text-[13px] leading-relaxed text-ink-2">
          The model is shown in the tunnel with its own paint and materials. Modes A and B then work on its{" "}
          <span className="text-ink">outer envelope</span>: width against height, sampled every 20 mm along the car. Mirrors,
          antennas, panel gaps, intakes, the interior and the underbody detail are not resolved. How faithful a downloaded
          model is to the real car is unknown, so results are estimates for <em>this model</em>, not measurements of the car.
          Files stay in this browser; nothing is uploaded.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".glb,.gltf,.obj,.stl,.zip,.bin,.mtl,.png,.jpg,.jpeg,.webp"
            className="sr-only"
            aria-label="Model files"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length > 0) void open(files);
            }}
          />
          <Button variant="primary" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
            Choose model files…
          </Button>
          <Button disabled={busy !== null} onClick={() => void openSample()}>
            Try the bundled sample
          </Button>
          <span className="text-xs text-ink-3">
            .glb, .gltf (with its .bin and textures), .obj (with .mtl), .stl, or a .zip of those. Files put in the
            project&apos;s <code>public/cars</code> folder are listed below. The sample is this app&apos;s own generic fastback
            written out as a mesh.
          </span>
        </div>
        {localModels.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-3">
              In <code className="text-ink-2">public/cars</code>:
            </span>
            {localModels.map((file) => (
              <Button key={file.name} size="sm" disabled={busy !== null} onClick={() => void openLocal(file.name)}>
                {file.name} <span className="num text-ink-3">· {(file.size / 1e6).toFixed(0)} MB</span>
              </Button>
            ))}
          </div>
        )}
        {busy && <p role="status" className="mt-2 text-[13px] text-ink-2">{busy}</p>}
        {error && (
          <div className="mt-2 max-w-[700px]">
            <ErrorBox code="IMPORT_FAILED" message={error} />
          </div>
        )}

        {loaded && placement && (
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
            <section aria-label="Model preview" className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <h2 className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">
                  {loaded.model.fileName}{" "}
                  <span className="num font-normal text-ink-3">· {loaded.model.triangles.toLocaleString("en-US")} triangles</span>
                </h2>
                <div className="flex gap-1.5" role="group" aria-label="Preview camera">
                  {(["three-quarter", "side", "front", "top"] as CameraPreset[]).map((preset) => (
                    <Button key={preset} size="sm" onClick={() => setCamera({ preset, nonce: camera.nonce + 1 })}>
                      {preset === "three-quarter" ? "3/4" : preset[0].toUpperCase() + preset.slice(1)}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="h-[440px] bg-bg">
                <ModelPreview
                  scene={loaded.model.scene}
                  matrix={placement.matrix}
                  length={placement.length}
                  camera={camera}
                  showModel={showModel || !measured}
                  envelope={measured ? { geometry: measured.fitted.geometry, bodyId: measured.bodyId } : null}
                />
              </div>
              <p className="border-t border-line px-3 py-2 text-xs leading-normal text-ink-2">
                The blue arrow is the airflow. The car must stand on its wheels and the arrow must point at its{" "}
                <span className="text-ink">nose</span>. If it does not, correct the orientation on the right.
                {measured && " The wireframe is the envelope and the wheels the solver will use."}
              </p>
              {measured && (
                <div className="border-t border-line px-3 py-2">
                  <Checkbox checked={showModel} onChange={setShowModel} label="Show the model under the solver's envelope" />
                </div>
              )}
            </section>

            <div className="flex min-w-0 flex-col gap-3">
              <section className="rounded-2xl border border-line bg-panel p-5" aria-labelledby="orient-heading">
                <h2 id="orient-heading" className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">1 · Orientation and size</h2>
                <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
                  <span className="text-ink-2">Up axis of the file</span>
                  <Select
                    ariaLabel="Up axis"
                    value={String(orientation.upAxis)}
                    options={AXES.map((axis, index) => ({ value: String(index), label: axis }))}
                    onChange={(value) => {
                      const upAxis = Number(value);
                      const lengthAxis = orientation.lengthAxis === upAxis ? (upAxis + 1) % 3 : orientation.lengthAxis;
                      changeOrientation({ ...orientation, upAxis, lengthAxis });
                    }}
                  />
                  <span className="text-ink-2">Length axis</span>
                  <Select
                    ariaLabel="Length axis"
                    value={String(orientation.lengthAxis)}
                    options={AXES.map((axis, index) => ({ value: String(index), label: axis, disabled: index === orientation.upAxis }))}
                    onChange={(value) => changeOrientation({ ...orientation, lengthAxis: Number(value) })}
                  />
                  <span className="text-ink-2">Nose</span>
                  <Button size="sm" onClick={() => changeOrientation({ ...orientation, reverse: !orientation.reverse })}>
                    Turn the car around
                  </Button>
                </div>
                <div className="mt-3 border-t border-line pt-2">
                  <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
                    <span className="text-ink-2">Real size from</span>
                    <Select<ScaleMode>
                      ariaLabel="How the model is scaled to real size"
                      value={scaleMode}
                      options={[
                        { value: "wheelbase", label: "A known wheelbase" },
                        { value: "length", label: "A known overall length" },
                        { value: "none", label: "The file (it is in metres)" },
                      ]}
                      onChange={setScaleMode}
                    />
                    {scaleMode === "wheelbase" && (
                      <>
                        <span className="text-ink-2">Wheelbase</span>
                        <span className="flex items-center gap-2">
                          <NumberInput ariaLabel="Wheelbase in metres" value={targetWheelbase} decimals={3} min={1.5} max={4.5} step={0.01} onCommit={setTargetWheelbase} className="w-24" />
                          <span className="text-ink-3">m</span>
                        </span>
                      </>
                    )}
                    {scaleMode === "length" && (
                      <>
                        <span className="text-ink-2">Overall length</span>
                        <span className="flex items-center gap-2">
                          <NumberInput ariaLabel="Overall length in metres" value={targetLength} decimals={3} min={2} max={7} step={0.01} onCommit={setTargetLength} className="w-24" />
                          <span className="text-ink-3">m</span>
                        </span>
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-normal text-ink-3">
                    {scaleMode === "wheelbase"
                      ? "Artist models come in arbitrary units. The wheelbase is the safest reference: bumpers, a rear-mounted spare wheel or a tow bar do not change it. The size shown is provisional until the model is measured."
                      : scaleMode === "length"
                        ? "Everything in the model counts toward this length, including a rear-mounted spare wheel if it has one."
                        : "Use this only when the file is known to be in metres."}
                  </p>
                </div>
                <dl className="num mt-2 grid grid-cols-3 gap-2 border-t border-line pt-2 text-[13px]">
                  {([["Length", placement.length], ["Width", placement.width], ["Height", placement.height]] as [string, number][]).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-ink-3">{label}</dt>
                      <dd className="text-ink">{value.toFixed(3)} m</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-1 text-[11px] text-ink-3">Bounding box of the included parts, mirrors included.</p>
                {!plausible && (
                  <p className="mt-2 text-xs text-warn">
                    {placement.length.toFixed(2)} m is not the length of a car. Give the real wheelbase or length above, or check the length axis.
                  </p>
                )}
              </section>

              <section className="rounded-2xl border border-line bg-panel p-5" aria-labelledby="car-heading">
                <h2 id="car-heading" className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">2 · Which car is it?</h2>
                <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
                  <span className="text-ink-2">Production car</span>
                  <Select
                    ariaLabel="Production car this model represents"
                    value={linkedCarId}
                    options={[{ value: NONE, label: "None / not in the library" }, ...REAL_CARS.map((car) => ({ value: car.id, label: car.name }))]}
                    onChange={chooseLinkedCar}
                  />
                  <span className="text-ink-2">Anchor class</span>
                  <Select
                    ariaLabel="Generic class that anchors the prediction"
                    value={anchorClassId}
                    options={BUILT_IN_VEHICLES.map((vehicle) => ({ value: vehicle.id, label: vehicle.name }))}
                    onChange={setAnchorClassId}
                  />
                  <span className="text-ink-2">Name</span>
                  <input className={inputClass} aria-label="Vehicle name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
                </div>
                <p className="mt-2 text-xs leading-normal text-ink-3">
                  A production car supplies its published length, mass and powertrain, and its published drag coefficient for
                  comparison only: predictions start from the generic class, never from the published figure.
                </p>
              </section>

              <details className="rounded-2xl border border-line bg-panel p-5" open={sortedParts.some((part) => part.sheet)}>
                <summary className="cursor-pointer text-[15px] font-semibold text-ink font-stretch-semi-expanded">
                  3 · Parts <span className="num font-normal text-ink-3">({sortedParts.length - excluded.size} of {sortedParts.length} included)</span>
                </summary>
                <p className="mt-1 text-xs text-ink-3">Untick anything that is not the car: ground planes, shadows, backdrops.</p>
                <ul className="scroll-thin mt-2 max-h-[180px] overflow-y-auto">
                  {sortedParts.slice(0, 80).map((part) => (
                    <li key={part.id} className="relative flex items-center justify-between gap-2 py-1 text-[13px]">
                      <Checkbox checked={!excluded.has(part.id)} onChange={() => togglePart(part.id)} label={part.sheet ? `${part.name} — flat sheet` : part.name} />
                      <span className="num shrink-0 text-ink-3">{part.triangles.toLocaleString("en-US")}</span>
                    </li>
                  ))}
                </ul>
                {sortedParts.length > 80 && <p className="mt-1 text-[11px] text-ink-3">The {sortedParts.length - 80} smallest parts are not listed and stay included.</p>}
              </details>

              <section className="rounded-2xl border border-line bg-panel p-5" aria-labelledby="measure-heading">
                <h2 id="measure-heading" className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">4 · Measure</h2>
                <div className="mt-2 flex items-center gap-2">
                  <Button variant={measured ? "default" : "primary"} disabled={busy !== null || !plausible} onClick={() => void measure()}>
                    {measured ? "Measure again" : "Measure the model"}
                  </Button>
                  {!measured && <span className="text-xs text-ink-3">Takes a few seconds for large models.</span>}
                </div>
                {measured && (
                  <>
                    <dl className="num mt-3 grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-[2px] text-[13px]">
                      <dt className="text-ink-3" />
                      <dd className="text-right text-[11px] text-ink-3">Model</dd>
                      <dd className="text-right text-[11px] text-ink-3">{published ? "vs published" : ""}</dd>
                      {(
                        [
                          [measured.measured.rearAttachment > 0 ? "Length of the body" : "Length", measured.measured.length, published?.length],
                          ["Width, mirrors removed", measured.measured.width, published?.width],
                          ["Height", measured.measured.height, published?.height],
                          ["Wheelbase", wheels ? wheels.rearAxleX - wheels.frontAxleX : null, published?.wheelbase],
                          ["Tyre diameter", wheels?.diameter ?? null, undefined],
                          ["Ride height (sill line)", measured.measured.rideHeight, undefined],
                        ] as [string, number | null, number | undefined][]
                      ).map(([label, value, reference]) => (
                        <div key={label} className="contents">
                          <dt className="text-ink-3">{label}</dt>
                          <dd className="text-right text-ink">{value === null ? "not found" : `${value.toFixed(3)} m`}</dd>
                          <dd className="text-right text-ink-2">{value !== null && reference ? percent(value, reference) : ""}</dd>
                        </div>
                      ))}
                    </dl>
                    {published && (
                      <p className="mt-2 text-xs leading-normal text-ink-3">
                        The {scaleMode === "wheelbase" ? "wheelbase" : "length"} matches by construction (the model was scaled to
                        it, to the nearest 20 mm station). The other differences show how well the model&apos;s proportions agree
                        with the manufacturer&apos;s figures.
                      </p>
                    )}
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-normal text-ink-2">
                      {!wheels && <li className="text-warn">No tyre contact patches were found on the ground: wheelbase and wheels are taken from the class.</li>}
                      {measured.measured.rearAttachment > 0 && (
                        <li>
                          A rear-mounted attachment {millimetres(measured.measured.rearAttachment)} deep (a spare wheel or carrier) is
                          drawn but is not part of the body the solver uses; with it the model is{" "}
                          {measured.measured.overallLength.toFixed(3)} m long. Published lengths usually leave it out as well.
                        </li>
                      )}
                      {measured.measured.tailSquared > measured.measured.resolution && (
                        <li>
                          Rounded tail: the last {millimetres(measured.measured.tailSquared)} are treated as a blunt base, because the
                          models start the wake from a flat rear face.
                        </li>
                      )}
                      {measured.fitted.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                      <li>
                        {SHAPE_PARAMS.length} shape parameters were fitted to the model for the empirical corrections; floor
                        smoothness, wheel exposure and cooling come from{" "}
                        {linkedCar ? `the ${linkedCar.name} look-alike` : `the ${getBuiltInVehicle(anchorClassId).name.toLowerCase()} class`}.
                      </li>
                    </ul>
                  </>
                )}
              </section>

              <section className="rounded-2xl border border-line bg-panel p-5" aria-labelledby="source-heading">
                <h2 id="source-heading" className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">5 · Source and licence</h2>
                <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
                  {(
                    [
                      ["title", "Model title"],
                      ["author", "Author"],
                      ["url", "Page URL"],
                      ["licence", "Licence"],
                    ] as [keyof typeof source, string][]
                  ).map(([key, label]) => (
                    <label key={key} className="contents">
                      <span className="text-ink-2">{label}</span>
                      <input
                        className={inputClass}
                        value={source[key]}
                        maxLength={300}
                        placeholder={key === "licence" ? "e.g. CC BY 4.0" : undefined}
                        onChange={(event) => setSource({ ...source, [key]: event.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-2">
                  <Checkbox
                    checked={rightsConfirmed}
                    onChange={setRightsConfirmed}
                    label="I may use this model under its licence"
                    hint="The credit is shown with the vehicle and in reports. Models taken from video games are usually not the uploader's to license."
                  />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" disabled={busy !== null || !measured || !rightsConfirmed} onClick={() => void save()}>
                    Save and open in the simulator
                  </Button>
                  {!measured && <span className="text-xs text-ink-3">Measure the model first.</span>}
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
