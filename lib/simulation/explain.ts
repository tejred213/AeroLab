/**
 * Plain-language summaries of a parameter study. The wording is deliberately
 * neutral: it reports what the simplified model computed and how the model
 * represents the mechanism, without claiming more than that.
 */
import { PARAM_BY_ID } from "@/lib/geometry/parameters";
import { MODEL } from "@/lib/physics/model";
import type { SweepResult, SweepRow } from "@/lib/simulation/sweep";
import type { ParamId } from "@/lib/types";
import { formatSigned, quantityOfParam, type UnitSystem, unitOf } from "@/lib/utils/units";

/** How each model represents the effect of a parameter. */
const MECHANISMS: Partial<Record<ParamId, string>> = {
  rideHeight:
    "In these models a lower floor restricts the flow under the car: underbody drag falls, less tyre is exposed, and the faster, lower-pressure underbody flow reduces lift.",
  rearWindowAngle:
    "In these models the rear-window angle sets whether the flow stays attached. Approaching about 30° strengthens the trailing vortices and raises drag; beyond it the flow is treated as separated from the roof edge.",
  windshieldAngle:
    "In these models a more upright windshield turns the flow more abruptly, which raises forebody pressure drag.",
  spoilerAngle:
    "In these models a steeper spoiler blade stands higher in the flow: it raises pressure on the deck, which lowers lift, and adds drag in proportion to its exposed height.",
  spoilerHeight:
    "In these models a longer spoiler blade raises pressure on the deck, which lowers lift, and adds drag in proportion to its exposed height.",
  diffuserAngle:
    "In these models the diffuser lets the underbody flow expand and recover pressure, adding downforce up to an optimum angle near 9°; beyond that its effectiveness falls as the flow is assumed to separate.",
  splitterExtension:
    "In these models the splitter carries high pressure on its upper surface and fast flow beneath it, adding front downforce for a small drag penalty.",
  wheelExposure:
    "In these models more exposed wheels increase wheelhouse and tyre drag; the effect on lift is not represented.",
  wingAngle:
    "In these models the rear wing follows finite-wing theory: downforce rises roughly linearly with angle until stall, and induced drag rises with the square of the wing's lift.",
  floorFlatness:
    "In these models a smoother floor lowers underbody drag and lets the floor and diffuser generate more suction.",
  roofHeight: "In these models a taller roof increases frontal area and the size of the base and wake.",
};

function describeDelta(value: number, decimals: number, unit: string): string {
  return `${formatSigned(value, decimals)}${unit ? ` ${unit}` : ""}`;
}

export function explainSweep(result: SweepResult, system: UnitSystem): string[] {
  const valid = result.rows.filter((row): row is SweepRow & { cd: number; cl: number; drag: number; downforce: number; topSpeed: number } => row.valid);
  if (valid.length < 2) {
    return ["Fewer than two points could be simulated, so no trend can be reported."];
  }
  const param = result.request.paramX;
  const definition = PARAM_BY_ID[param];
  const unit = unitOf(system, quantityOfParam(definition.kind));
  const first = valid[0];
  const last = valid[valid.length - 1];
  const from = unit.toDisplay(first.x).toFixed(definition.kind === "ratio" ? 2 : unit.decimals);
  const to = unit.toDisplay(last.x).toFixed(definition.kind === "ratio" ? 2 : unit.decimals);
  const direction = last.x > first.x ? "Increasing" : "Reducing";

  const force = unitOf(system, "force");
  const speed = unitOf(system, "speed");
  const dCd = last.cd - first.cd;
  const dCl = last.cl - first.cl;
  const dDrag = force.toDisplay(last.drag) - force.toDisplay(first.drag);
  const dDown = force.toDisplay(last.downforce) - force.toDisplay(first.downforce);
  const dTop = speed.toDisplay(last.topSpeed) - speed.toDisplay(first.topSpeed);

  const paragraphs: string[] = [];
  paragraphs.push(
    `${direction} ${definition.label.toLowerCase()} from ${from} to ${to}${unit.label ? ` ${unit.label}` : ""} changed the estimated drag coefficient by ` +
      `${formatSigned(dCd, 3)} (${first.cd.toFixed(3)} → ${last.cd.toFixed(3)}) and the lift coefficient by ${formatSigned(dCl, 3)} ` +
      `(${formatSigned(first.cl, 3)} → ${formatSigned(last.cl, 3)}). At the test speed that is ${describeDelta(dDrag, 0, force.label)} of drag and ` +
      `${describeDelta(dDown, 0, force.label)} of downforce, and the estimated top speed changed by ${describeDelta(dTop, 1, speed.label)}.`,
  );

  const monotonic = (pick: (row: (typeof valid)[number]) => number) => {
    const signs = new Set<number>();
    for (let i = 1; i < valid.length; i++) {
      const delta = pick(valid[i]) - pick(valid[i - 1]);
      if (Math.abs(delta) > 1e-9) signs.add(Math.sign(delta));
    }
    return signs.size <= 1;
  };
  if (!monotonic((row) => row.cd) || !monotonic((row) => row.cl)) {
    paragraphs.push(
      "The trend is not monotonic over this range: the response reverses between steps, so the end-to-end change above does not describe the intermediate points.",
    );
  }

  const mechanism = MECHANISMS[param];
  if (mechanism) paragraphs.push(mechanism);

  const mode = result.request.config.mode;
  const deltaShare =
    mode === "reduced-order" ? MODEL.uncertainty.reducedOrder.cdDelta : MODEL.uncertainty.analytical.cdDelta;
  paragraphs.push(
    `These are outputs of a simplified model (${result.provenance}), not measurements. By the model's own error estimate the size of a ` +
      `predicted change is uncertain by roughly ±${Math.round(deltaShare * 100)} %; the direction of the change is its more reliable part. ` +
      "Effects the model does not represent may add to, or offset, what is shown.",
  );
  return paragraphs;
}
