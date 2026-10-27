import type { Viewport } from "next";
import { Fragment } from "react";
import { LandingHero } from "@/components/dashboard/LandingHero";
import { LandingCurtain, LandingLink } from "@/components/dashboard/LandingLink";
import { ProfileDrawing } from "@/components/dashboard/ProfileDrawing";
import { Badge, ClientOnly } from "@/components/ui/Layout";
import { buildBodyShape, spoilerGeometry } from "@/lib/geometry/profile";
import { BUILT_IN_VEHICLES, REAL_CARS } from "@/lib/vehicle/library";

// The landing page is white; the rest of the app keeps the dark theme colour.
export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

const NAV: { href: string; label: string }[] = [
  { href: "/compare", label: "Compare" },
  { href: "/library", label: "Library" },
  { href: "/validation", label: "Validation" },
  { href: "/settings", label: "Settings" },
];

const CHAIN = ["Geometry", "Airflow", "Aerodynamic forces", "Vehicle dynamics", "Performance"];

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Reshape the car",
    body: "Change 31 shape parameters directly on the model: windshield and rear-window angles, roofline, overhangs, ride height, spoiler, wing and diffuser. Each control explains what it does to the air.",
  },
  {
    title: "Watch the flow",
    body: "Tracer particles and streamlines follow a solved flow field around the body. Add pressure and velocity slices, the wake, separation markers and force arrows. The field is a reduced-order solution and is labelled as one.",
  },
  {
    title: "Read the consequence",
    body: "Drag and lift coefficients with their uncertainty, front and rear lift, the power needed at speed, top speed, acceleration and the steepest gradient the car can climb.",
  },
  {
    title: "Run a study",
    body: "Sweep one parameter, map two against each other, or let the optimiser search for the lowest drag, the most downforce or the highest top speed within limits you set. Experiment mode answers one question at a time, such as what happens when the ride height drops.",
  },
  {
    title: "Start from a known shape",
    body: `${BUILT_IN_VEHICLES.length} generic classes and ${REAL_CARS.length} production cars rebuilt as simplified look-alikes, or a 3D model of your own. Published drag figures are shown for comparison and are never given to the model.`,
  },
  {
    title: "Compare and export",
    body: "Put configurations side by side with overlaid charts and a table of what changed. Export charts as PNG, SVG or CSV, results as JSON, and a printable engineering report.",
  },
];

const TOPICS: { title: string; body: string }[] = [
  { title: "Drag", body: "How shape, frontal area and speed set the force resisting motion, and what it costs in power." },
  { title: "Downforce", body: "Where vertical aerodynamic load comes from, and the drag paid for it." },
  { title: "Flow Separation", body: "Where the air leaves the body, how large the wake becomes, and why 30° matters." },
  { title: "Ride Height", body: "How the gap to the road changes underbody flow, lift and drag." },
  { title: "Spoiler Angle", body: "How a lip spoiler trades deck pressure against drag as it stands up into the flow." },
  { title: "Body Shape", body: "Roofline, windshield rake, rear slope and boat-tail, changed directly on the model." },
  { title: "Road Gradient", body: "How a slope adds to, or subtracts from, the forces the powertrain must overcome." },
  { title: "Top Speed", body: "Where available wheel power meets aerodynamic, rolling and gradient demand." },
];

/** Tones match the badge each mode carries next to its results in the simulator. */
const MODES: { id: string; name: string; tone: "data" | "accent" | "ok" | "warn"; body: string }[] = [
  { id: "A", name: "Analytical", tone: "data", body: "Closed-form correlations. Instant. No flow field is solved." },
  { id: "B", name: "Reduced-order", tone: "accent", body: "3D potential flow solved numerically, plus empirical wake closures." },
  { id: "C", name: "CFD", tone: "ok", body: "OpenFOAM adapter on the backend. Runs only where a solver is installed." },
  { id: "D", name: "ML surrogate", tone: "warn", body: "Tree-ensemble regressor trained on results from another mode." },
];

/** Width of each class's side profile as drawn, m, so the six can share one scale. */
const LINEUP = BUILT_IN_VEHICLES.map((vehicle) => {
  const shape = buildBodyShape(vehicle.geometry);
  const spoiler = spoilerGeometry(shape);
  return { vehicle, drawnLength: shape.length + (spoiler.present ? spoiler.x1 - shape.length : 0) + 0.5 };
});
const LONGEST = Math.max(...LINEUP.map((entry) => entry.drawnLength));

const SECTION_HEADING = "text-[clamp(26px,3vw,38px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded";
const CONTAINER = "mx-auto w-full max-w-[1240px] px-8 max-sm:px-5";
const PRIMARY_BUTTON =
  "inline-flex h-12 items-center rounded-lg bg-[#f2a33a] px-6 text-[15px] font-semibold text-[#1a1206] transition-[filter] hover:brightness-105";

function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
      <path d="M1 13 C5 13 6 5 10 5 C13 5 14 9 17 9" fill="none" stroke="#f2a33a" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M1 16 H17" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div className="landing">
      <LandingCurtain />
      <header className="landing-nav">
        <div className="flex h-14 items-center justify-between gap-4 px-8 max-sm:px-4">
          <span className="flex items-center gap-2.5 text-ink">
            <Mark />
            <span className="landing-brand text-[17px] font-bold tracking-[-0.01em] font-stretch-expanded">AeroLab</span>
          </span>
          <nav aria-label="Primary" className="flex items-center gap-0.5">
            {NAV.map((item) => (
              <LandingLink
                key={item.href}
                href={item.href}
                className="flex h-9 items-center rounded-md px-3 text-sm font-medium text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink max-md:hidden"
              >
                {item.label}
              </LandingLink>
            ))}
            <LandingLink
              href="/simulator"
              className="ml-2 inline-flex h-9 items-center rounded-lg bg-ink px-4 text-sm font-semibold text-bg transition-opacity hover:opacity-85"
            >
              Launch Simulator
            </LandingLink>
          </nav>
        </div>
      </header>

      <main>
        {/* The scene fills the first screen. Scrolling holds it in place and brings the name up beneath it. */}
        <section className="landing-stage" aria-label="AeroLab">
          <div className="landing-pin">
            <ClientOnly>
              <LandingHero />
            </ClientOnly>
            <div className="landing-name">
              <h1 className="landing-wordmark">AeroLab</h1>
              <p className="mt-[2.2svh] text-[clamp(15px,1.5vw,21px)] font-medium tracking-[-0.005em] text-ink-2">
                Shape the air. Measure the consequence.
              </p>
            </div>
            <div className="landing-cue" aria-hidden>
              <span>Scroll</span>
              <svg width="12" height="18" viewBox="0 0 12 18">
                <path d="M6 1v15M1.5 11.5 6 16l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </section>

        <section className={`${CONTAINER} pt-24 pb-20 max-sm:pt-16 max-sm:pb-14`}>
          <div className="grid items-end gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
            <p className="text-[clamp(24px,2.7vw,38px)] leading-[1.18] font-medium tracking-[-0.02em] text-ink">
              An interactive virtual wind tunnel for exploring how vehicle geometry changes aerodynamic behavior and
              real-world performance.
            </p>
            <div>
              <div className="flex flex-wrap gap-3">
                <LandingLink href="/simulator" className={PRIMARY_BUTTON}>
                  Launch Simulator
                </LandingLink>
                <LandingLink
                  href="/library"
                  className="inline-flex h-12 items-center rounded-lg border border-line-strong px-6 text-[15px] font-medium text-ink transition-colors hover:border-ink-3 hover:bg-panel-2"
                >
                  Explore Vehicle Library
                </LandingLink>
              </div>
              <p className="mt-5 text-sm leading-relaxed text-ink-3">
                Educational and research-oriented. AeroLab uses simplified models with stated assumptions; it does not
                replace professional CFD or wind-tunnel testing.
              </p>
            </div>
          </div>

          <div className="mt-16 flex flex-wrap items-center gap-x-10 gap-y-3 border-y border-line py-6" aria-labelledby="chain-heading">
            <h2 id="chain-heading" className="text-sm text-ink-3">
              What the simulator connects
            </h2>
            <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-base font-medium text-ink">
              {CHAIN.map((step, index) => (
                <Fragment key={step}>
                  {index > 0 && (
                    <li aria-hidden className="text-ink-3">
                      <svg width="18" height="10" viewBox="0 0 18 10">
                        <path d="M1 5h15M12 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </li>
                  )}
                  <li>{step}</li>
                </Fragment>
              ))}
            </ol>
          </div>
        </section>

        <section className={`${CONTAINER} pb-24 max-sm:pb-16`} aria-labelledby="features-heading">
          <div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <h2 id="features-heading" className={`${SECTION_HEADING} lg:sticky lg:top-24 lg:self-start`}>
              What it does
            </h2>
            <dl>
              {FEATURES.map((feature) => (
                <div key={feature.title} className="grid gap-x-10 gap-y-2 border-t border-line py-7 first:border-t-0 first:pt-0 md:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]">
                  <dt className="text-xl leading-snug font-semibold tracking-[-0.01em] text-ink font-stretch-semi-expanded">{feature.title}</dt>
                  <dd className="text-base leading-relaxed text-ink-2">{feature.body}</dd>
                </div>
              ))}
            </dl>
          </div>

          <figure className="mt-16 border-y border-line py-10">
            <ul className="grid grid-cols-2 items-end gap-x-8 gap-y-10 md:grid-cols-3 xl:grid-cols-6">
              {LINEUP.map(({ vehicle, drawnLength }) => (
                <li key={vehicle.id} className="flex flex-col items-center justify-end gap-3">
                  <div style={{ width: `${(drawnLength / LONGEST) * 100}%` }}>
                    <ProfileDrawing
                      theme="light"
                      className="block h-auto w-full"
                      ariaLabel={`Side profile of the ${vehicle.name}`}
                      layers={[{ geometry: vehicle.geometry, color: "#0b0d10" }]}
                    />
                  </div>
                  <span className="text-sm font-medium text-ink">{vehicle.name}</span>
                </li>
              ))}
            </ul>
            <figcaption className="mt-8 text-sm text-ink-3">
              The {BUILT_IN_VEHICLES.length} generic classes, each drawn from its shape parameters at one common scale.
            </figcaption>
          </figure>
        </section>

        <section className={`${CONTAINER} pb-24 max-sm:pb-16`} aria-labelledby="topics-heading">
          <h2 id="topics-heading" className={SECTION_HEADING}>
            What can you investigate?
          </h2>
          <ul className="mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-4">
            {TOPICS.map((topic) => (
              <li key={topic.title} className="border-t border-line pt-5 pb-8">
                <h3 className="text-[17px] font-semibold text-ink font-stretch-semi-expanded">{topic.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{topic.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className={`${CONTAINER} pb-28 max-sm:pb-20`} aria-labelledby="modes-heading">
          <h2 id="modes-heading" className={SECTION_HEADING}>
            Four simulation modes, always labelled
          </h2>
          <p className="mt-4 max-w-[68ch] text-base leading-relaxed text-ink-2">
            Every number in AeroLab states which model produced it. An analytical estimate is never presented as CFD,
            and a surrogate prediction is never presented as physics.
          </p>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {MODES.map((mode) => (
              <li key={mode.id} className="rounded-2xl bg-panel-2 p-6">
                <Badge tone={mode.tone}>Mode {mode.id}</Badge>
                <h3 className="mt-4 text-[17px] font-semibold text-ink font-stretch-semi-expanded">{mode.name}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{mode.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      {/* The page ends in the colour of the tunnel it opens into. */}
      <footer className="on-dark bg-[#0b0d10]">
        <div className={`${CONTAINER} flex flex-wrap items-end justify-between gap-x-16 gap-y-10 py-20 max-sm:py-14`}>
          <div>
            <p className="text-[clamp(28px,3.4vw,46px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">
              <span className="block">Pick a car.</span>
              <span className="block">Change one thing.</span>
              <span className="block">Run it.</span>
            </p>
            <p className="mt-6 max-w-[60ch] text-sm leading-relaxed text-ink-3">
              Educational and research-oriented. Simplified models with stated assumptions; not a replacement for
              professional CFD or wind-tunnel testing.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <LandingLink href="/simulator" className={PRIMARY_BUTTON}>
              Launch Simulator
            </LandingLink>
            <LandingLink
              href="/library"
              className="inline-flex h-12 items-center rounded-lg border border-line-strong px-6 text-[15px] font-medium text-ink transition-colors hover:border-ink-3 hover:bg-panel-2"
            >
              Explore Vehicle Library
            </LandingLink>
          </div>
        </div>
      </footer>
    </div>
  );
}
