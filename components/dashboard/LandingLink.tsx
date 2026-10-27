"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { leaveLanding, useArrival } from "@/lib/state/pageTransition";

interface LandingLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
}

/**
 * A link from the landing page into the app. An ordinary click darkens the page before it leaves
 * (see lib/state/pageTransition); opening in a new tab or window is left to the browser. A link to
 * the simulator opens it with the car in the scene while the simulator session is still untouched.
 */
export function LandingLink({ href, className, children }: LandingLinkProps) {
  const router = useRouter();
  return (
    <Link
      href={href}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        leaveLanding((target) => router.push(target), href, { vehicle: "shown-if-untouched" });
      }}
    >
      {children}
    </Link>
  );
}

/**
 * The dark layer the landing page fades to on the way into the app, in the app's own background
 * colour, so the page that follows appears on the surface that is already there. Coming back from
 * the app it starts dark and lifts.
 */
export function LandingCurtain() {
  const arrival = useArrival("landing");
  // Dark for the first frame when arriving from the app, then lifted.
  const [lowered, setLowered] = useState(arrival === "surface");
  useEffect(() => {
    if (!lowered) return;
    // A timer, not an animation frame: a page that is not being drawn yet must still end up lit.
    const timer = window.setTimeout(() => setLowered(false), 40);
    return () => window.clearTimeout(timer);
  }, [lowered]);

  return (
    <div className="landing-curtain" data-lowered={lowered} aria-hidden>
      {/* The same words, in the same place, as the simulator shows while it starts. */}
      <span className="landing-curtain-note">Loading simulator…</span>
    </div>
  );
}
