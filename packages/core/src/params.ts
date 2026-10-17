// Shared spread parameters for the GPU cellular automaton and CPU planner.
// These hackathon assumptions are not fitted Rothermel coefficients.
export const SpreadParams = {
  ph: 0.58,
  c1: 0.045,
  c2: 0.131,
  a: 0.078,
  spot: {
    pBase: 0.02,
    distMeanPerWindMs: 40,
    samples: 4,
  },
  // Minutes per step; synthetic default until Eaton replay calibration is complete.
  stepMinutes: 5,
};

export const TreatmentEffect = {
  break: { fuelMul: 0.05 },
  burn: { fuelMul: 0.3 },
  thin: { rosMul: 0.5 },
  zone0: { emberMul: 0.3 },
};

export const PlanningParams = {
  // Legacy export for callers; CA-derived travel costs no longer use this speed.
  baseRosMPerMinute: 5,
  referenceCellSize: 25,
  // Synthetic CA alignment: median observed/predicted ratio was 0.3469 on
  // mock 128², wind 3/6/10 m/s, reference seed 1. Rounded to avoid false precision.
  // Seeds 2–3 were held out; this is NOT an Eaton/operational calibration.
  arrivalTimeScale: 0.35,
  minRos: 0.000001,
  maxRos: 500,
  costPerCell: { break: 100, burn: 30, thin: 60, zone0: 250 },
};
