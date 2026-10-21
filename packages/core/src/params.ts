// Shared spread parameters for the GPU cellular automaton and CPU planner.
// These hackathon assumptions are not fitted Rothermel coefficients.
export const SpreadParams = {
  ph: 0.58,
  c1: 0.045,
  c2: 0.131,
  a: 0.078,
  spot: {
    pBase: 0.03,
    // Light embers from grass and sage scrub: lognormal (sigma 0.6) flight distance with this
    // mean per m/s of wind, and they burn out aloft after about 16 s, so none lands farther
    // than distMaxPerWindMs per m/s. A 150 m fuel break therefore stops them below ~10 m/s.
    distMeanPerWindMs: 12,
    distMaxPerWindMs: 16,
    // Rare lofted embers (structures, palms, lifted brush) travel far in strong wind, like the
    // Norte MIRADA spot fire 2.4 km downwind. Their share of samples ramps from 0 at 5 m/s to
    // longShare at 10 m/s; lognormal (sigma 1.0) with this mean per m/s, uncapped.
    longShare: 0.002,
    longMeanPerWindMs: 160,
    samples: 4,
  },
  // Minutes per step; synthetic default until Eaton replay calibration is complete.
  stepMinutes: 5,
};

// fuelMul is the fuel left in a treated cell. It lowers the chance that the cell ignites and,
// once it burns, how strongly it spreads to neighbours and how many embers it throws.
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
