/** Concise, technically accurate explanations shown in tooltips next to metrics. */
export const GLOSSARY = {
  cd: "Drag coefficient. Dimensionless coefficient describing aerodynamic resistance. Lower values generally indicate less drag for the same frontal area and airspeed.",
  cl: "Lift coefficient. Dimensionless vertical-force coefficient referenced to frontal area. Positive values lift the car; negative values press it onto the road (downforce).",
  clFront: "Share of the lift coefficient acting on the front axle. Front and rear lift together set the aerodynamic balance.",
  clRear: "Share of the lift coefficient acting on the rear axle.",
  cs: "Side-force coefficient, referenced to frontal area. Non-zero only when the relative wind is yawed (crosswind).",
  cmYaw: "Yaw-moment coefficient about mid-wheelbase (reference: frontal area × wheelbase). Positive means the nose is pushed downwind.",
  cda: "Drag area Cd × A. The quantity that actually sets drag force at a given speed and air density.",
  drag: "Aerodynamic drag force Fd = ½ ρ V² Cd A, acting along the vehicle axis against the direction of travel.",
  lift: "Aerodynamic vertical force Fl = ½ ρ V² Cl A. Positive is upward.",
  downforce: "Vertical aerodynamic force acting toward the road surface (the negative of lift).",
  sideForce: "Lateral aerodynamic force caused by a yawed relative wind.",
  yawMoment: "Aerodynamic moment about the vertical axis through mid-wheelbase. Positive pushes the nose downwind.",
  dynamicPressure: "Pressure associated with the kinetic energy of moving air: q = ½ ρ V².",
  reynolds: "Reynolds number based on vehicle length: ratio of inertial to viscous forces in the flow. Road cars operate around 10⁷, where coefficients change only slowly with speed.",
  frontalArea: "Area of the vehicle's silhouette projected onto a plane normal to the direction of travel, computed from the generated geometry. It is the reference area of every coefficient.",
  topSpeed: "Speed at which the maximum force available at the wheels equals the total resistance (aerodynamic + rolling + gradient), or the rev limit if that comes first.",
  accel: "Time to accelerate from rest to the stated speed at full throttle, integrating a = (F_traction − F_total) / m_effective with a traction limit.",
  powerRequired: "Power needed at the wheels to hold a steady speed: P = (F_drag + F_rolling + F_grade) × V. The aerodynamic part grows with V³.",
  rolling: "Rolling resistance of the tyres: F_rr = C_rr × N, where N is the tyre normal load (m g on a level road with no lift).",
  grade: "Component of weight along the road: F_grade = m g sin θ. Positive (resisting) uphill, negative downhill.",
  totalResistance: "F_total = F_drag + F_rolling + F_grade at the test speed.",
  efficiency: "Aerodynamic efficiency: downforce divided by drag (−Cl / Cd). Higher means more downforce for a given drag penalty.",
  uncertainty:
    "Uncertainty reflects model assumptions and reduced-order approximation: a floor for the calibrated reference shape plus a fraction of the predicted change from it. It is not a measurement error bar.",
  basePressure: "Pressure coefficient acting on the separated base of the body. More negative values mean more base drag.",
  separation: "Where the flow detaches from the body surface. Behind it lies the wake, a region of low pressure and recirculating air.",
  yawAngle: "Angle between the relative wind and the vehicle's longitudinal axis. Zero in still air or a pure headwind.",
  maxGrade: "Steepest gradient the vehicle can hold at 30 km/h, limited by wheel force or tyre traction.",
  range: "Steady-speed range at 100 km/h on the configured gradient: usable battery energy × drivetrain efficiency ÷ total resistance. Ignores auxiliaries and temperature.",
  calibration:
    "Each vehicle class has approximate reference coefficients. The model reports the reference plus the change it predicts between your geometry and the class reference geometry. This term is the offset between the raw model and the reference.",
  blockage: "Frontal area divided by the test-section cross-section. Large values distort the flow around the vehicle.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
