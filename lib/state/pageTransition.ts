"use client";

/**
 * Page changes. Every navigation inside the site is a short two-part change instead of a cut: what
 * is on screen leaves, then the next page's parts arrive. Between the white landing page and the
 * dark app the whole screen goes through the app's background colour; between two pages of the app
 * the header stays put and only the content under it changes. This module only remembers which
 * side was on screen last, across navigations; it holds no application state.
 */
import { useEffect, useState } from "react";
import { diffGeometry } from "@/lib/geometry/parameters";
import { vehicleSpecOf } from "@/lib/simulation/config";
import { useSimStore } from "@/lib/state/simStore";
import { DEFAULT_VEHICLE_ID, getBuiltInVehicle } from "@/lib/vehicle/library";

/** The two sides: the white landing page, and every page of the dark app. */
export type Surface = "app" | "landing";

/** How an arrival came about: from the other side, or from another page of the same side. */
export type Arrival = "surface" | "page";

/** How long the landing page takes to darken before the next page is asked for, ms (matches the CSS). */
export const LEAVE_MS = 460;
/** The same for a page of the app: going to another of its pages, and going to the landing page. */
const LEAVE_PAGE_MS = 150;
const LEAVE_APP_MS = 220;
/** How long the arriving page's parts take to settle, ms; after this the arrival is over. */
const ARRIVE_MS = 900;
/** If the next page has not appeared by then, the page that was left is shown again, ms. */
const GIVE_UP_MS = 5000;

/** The side that was on screen before this navigation; null on a fresh page load. */
let lastSurface: Surface | null = null;
let shownVehicleId: string | null = null;
let giveUp: number | null = null;

/**
 * For a component that is on every page of one side. For a moment after a navigation it returns
 * how the page was arrived at: "surface" from the other side, "page" from another page of the same
 * side; by a link, the logo or the browser's back and forward buttons alike. It is read during
 * render, so the very first frame is already in the arriving state. A fresh page load is not an
 * arrival and returns null.
 */
export function useArrival(surface: Surface): Arrival | null {
  const [arrival, setArrival] = useState<Arrival | null>(() => (lastSurface === null ? null : lastSurface === surface ? "page" : "surface"));
  useEffect(() => {
    lastSurface = surface;
    // The page that was left marked the document as leaving; this is the page it left for.
    delete document.documentElement.dataset.leaving;
    if (giveUp !== null) window.clearTimeout(giveUp);
    giveUp = null;
  }, [surface]);
  useEffect(() => {
    if (!arrival) return;
    const timer = window.setTimeout(() => setArrival(null), ARRIVE_MS);
    return () => window.clearTimeout(timer);
  }, [arrival]);
  return arrival;
}

/**
 * Leaves a page of the app: its content fades out, then the navigation happens. Going to another
 * page of the app only the content under the header leaves; going to the landing page, or from a
 * page without the app header, everything does. With reduced motion it navigates straight away.
 */
export function leavePage(navigate: (href: string) => void, href: string): void {
  const root = document.documentElement;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    navigate(href);
    return;
  }
  // A second click while the page is already leaving changes nothing.
  if (root.dataset.leaving) return;
  const everything = new URL(href, window.location.href).pathname === "/" || !document.querySelector("header[data-app-header]");
  root.dataset.leaving = everything ? "surface" : "page";
  window.setTimeout(() => navigate(href), everything ? LEAVE_APP_MS : LEAVE_PAGE_MS);
  giveUp = window.setTimeout(() => {
    delete root.dataset.leaving;
    giveUp = null;
  }, GIVE_UP_MS);
}

/** The landing page reports which car its scene is showing. */
export function reportShownVehicle(id: string): void {
  shownVehicleId = id;
}

/** True when nothing in the simulator session has been changed from the default vehicle. */
function sessionIsUntouched(): boolean {
  const session = useSimStore.getState();
  const base = getBuiltInVehicle(DEFAULT_VEHICLE_ID);
  return (
    session.vehicleId === base.id &&
    session.result === null &&
    diffGeometry(base.geometry, session.geometry).length === 0 &&
    JSON.stringify(session.spec) === JSON.stringify(vehicleSpecOf(base)) &&
    JSON.stringify(session.powertrain) === JSON.stringify(base.powertrain)
  );
}

interface LeaveOptions {
  /**
   * "shown" opens the simulator with the car in the landing scene. "shown-if-untouched" does so only
   * while the session is still the untouched default, so that work in progress is never replaced.
   */
  vehicle?: "shown" | "shown-if-untouched";
}

/**
 * Leaves the landing page for a page of the app: darkens the page, then navigates. With reduced
 * motion, or when the landing page is not what is on screen, it navigates straight away.
 */
export function leaveLanding(navigate: (href: string) => void, href: string, options: LeaveOptions = {}): void {
  if (href === "/simulator" && shownVehicleId && (options.vehicle === "shown" || (options.vehicle === "shown-if-untouched" && sessionIsUntouched()))) {
    useSimStore.getState().selectVehicle(shownVehicleId);
  }
  const root = document.querySelector<HTMLElement>(".landing");
  if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    navigate(href);
    return;
  }
  // A second click while the page is already darkening changes nothing.
  if (root.dataset.leaving) return;
  root.dataset.leaving = href === "/simulator" ? "simulator" : "page";
  window.setTimeout(() => navigate(href), LEAVE_MS);
}
