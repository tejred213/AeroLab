import realCarData from "@/shared/real-cars.json";
import vehicleData from "@/shared/vehicles.json";
import type { Drivetrain, GeometryParams, ParamBasis, ParamId, Powertrain, PublishedCarData, VehicleDefinition } from "@/lib/types";

/** Built-in generic vehicle classes (approximate reference values, not manufacturer data). */
export const BUILT_IN_VEHICLES: VehicleDefinition[] = vehicleData.vehicles as VehicleDefinition[];

export const DEFAULT_VEHICLE_ID = "fastback";

/** One entry of shared/real-cars.json. */
interface RealCarRecord {
  id: string;
  name: string;
  years: string;
  bodyStyle: string;
  anchorClass: string;
  published: PublishedCarData;
  sources: { label: string; url: string }[];
  notes: string[];
  geometry: GeometryParams;
  basis: Record<ParamId, ParamBasis>;
  mass: number;
  drivetrain: Drivetrain;
  weightDistFront?: number;
  /** Published powertrain figures; everything not given comes from the anchor class. */
  powertrain: Partial<Powertrain> & { type: Powertrain["type"] };
}

/**
 * A production car as a library vehicle. Its calibration anchor is the generic
 * class, not the car: the reference coefficients and the geometry they belong
 * to are the class's, so the car's own coefficients are a prediction.
 */
function toVehicle(record: RealCarRecord): VehicleDefinition {
  const anchor = BUILT_IN_VEHICLES.find((vehicle) => vehicle.id === record.anchorClass);
  if (!anchor) throw new Error(`Real car "${record.id}" names an unknown anchor class "${record.anchorClass}"`);
  if (anchor.powertrain.type !== record.powertrain.type) {
    throw new Error(`Real car "${record.id}" and its anchor class "${anchor.id}" have different powertrain types`);
  }
  return {
    id: record.id,
    name: record.name,
    description:
      `Parametric look-alike of the ${record.name} (${record.years}), built from published dimensions and estimated proportions. ` +
      "It is a simplified shape, not the manufacturer's surfaces.",
    reference: { ...anchor.reference },
    referenceGeometry: { ...anchor.geometry },
    geometry: { ...record.geometry },
    mass: record.mass,
    drivetrain: record.drivetrain,
    // Chassis values that are rarely published come from the class.
    cgHeight: anchor.cgHeight,
    weightDistFront: record.weightDistFront ?? anchor.weightDistFront,
    crr: anchor.crr,
    tireMu: anchor.tireMu,
    // Published power and torque on the class's generic gearing.
    powertrain: { ...structuredClone(anchor.powertrain), ...record.powertrain } as Powertrain,
    realCar: {
      years: record.years,
      bodyStyle: record.bodyStyle,
      anchorClassId: anchor.id,
      anchorClassName: anchor.name,
      published: record.published,
      sources: record.sources,
      notes: record.notes,
      basis: record.basis,
    },
  };
}

/** Production cars as parametric look-alikes (published figures for comparison; see shared/real-cars.json). */
export const REAL_CARS: VehicleDefinition[] = (realCarData.cars as unknown as RealCarRecord[]).map(toVehicle);

/** Every vehicle that ships with the app: the generic classes, then the production-car look-alikes. */
export const LIBRARY_VEHICLES: VehicleDefinition[] = [...BUILT_IN_VEHICLES, ...REAL_CARS];

export function findVehicle(id: string, custom: VehicleDefinition[] = []): VehicleDefinition | undefined {
  return LIBRARY_VEHICLES.find((vehicle) => vehicle.id === id) ?? custom.find((vehicle) => vehicle.id === id);
}

export function getBuiltInVehicle(id: string): VehicleDefinition {
  const vehicle = LIBRARY_VEHICLES.find((candidate) => candidate.id === id);
  if (!vehicle) throw new Error(`Unknown built-in vehicle "${id}"`);
  return vehicle;
}
