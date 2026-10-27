import aeroModel from "@/shared/aero-model.json";

/**
 * Coefficients of the semi-empirical models, loaded from shared/aero-model.json.
 * The Python backend reads the same file, which keeps both implementations in step.
 */
export const MODEL = aeroModel;

export const MODEL_VERSION: string = aeroModel.version;

export const GRAVITY: number = aeroModel.air.gravity;

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
