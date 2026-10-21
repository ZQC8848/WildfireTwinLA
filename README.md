# WildfireTwinLA: a wildfire digital twin for Southern California

A 3D digital twin of the San Clemente / San Juan Capistrano hills that runs in the browser
(Three.js). It keeps vegetation fuel up to date from satellite data and simulates fire spread on
the GPU. Algorithms help people decide where fuel treatments (fuel breaks, prescribed burns,
home hardening) protect communities best. During a fire it forwards hotspots, projects the spread
and prioritizes outreach to the homes the fire will reach first.

**Try it live: <https://wildfiretwinla.vercel.app/>** (runs entirely in your browser; residents
and calls are simulated)

- Event: The Dual-Use Hackathon (InnovateLA × USC Viterbi, closing event of LA Tech Week 2026,
  2026-10-16 to 10-18)
- Technical design: [docs/technical-design.md](docs/technical-design.md)
- Data and realtime backend design: [docs/backend-design.md](docs/backend-design.md)
- Backend delivery, timeline and compliance audit: [docs/backend-delivery-and-compliance.md](docs/backend-delivery-and-compliance.md)
- Offline grid tools and replay builder: [data-pipeline/README.md](data-pipeline/README.md)
- Realtime backend: [server/README.md](server/README.md)
- Emergency contact (call lines, queue, texts): [docs/emergency-contact.md](docs/emergency-contact.md)
- Demo incident and data boundaries: [docs/norte-fire.md](docs/norte-fire.md)
- Terrain wind field format: [docs/wind-field.md](docs/wind-field.md)
- Deployment (Vercel): [docs/deploy.md](docs/deploy.md)
- Team roles and interfaces: [docs/team-plan.md](docs/team-plan.md)

The demo incident is the **2026 Norte Fire (San Clemente / San Juan Capistrano, Orange
County)**. Respond mode replays it from public data: day one of the fire, then the official
updates of the next two days. Eaton is kept only as a legacy replay.

## Features

| Module | What it does | Status |
|---|---|---|
| 3D scene | DEM terrain, satellite imagery, fuel layers, building and tree models, flames and smoke, isochrones, timeline | Done |
| Fire spread | GPU cellular automaton (slope, terrain-adjusted wind, fuel, dryness, embers); a 64-run ensemble gives burn probability and arrival time | Done |
| Norte replay | NIFC ignitions, NASA FIRMS VIIRS passes and NOAA HRRR wind, assimilated into the simulation and scored against the satellite detections. Crews' knockdown stops the model fire and a later satellite pass with no heat puts it out. CAL FIRE containment, lifted orders and the NIFC perimeter follow | Done |
| Live feed | Polls NASA FIRMS, GOES-18 and wind, clusters hotspots into incidents and pushes them over WebSocket (needs the backend) | Done |
| Treatment planning | Draw fuel breaks, burns, thinning and home hardening; compare your plan with greedy and min-cut plans under the same fire, 5 runs each | Done |
| Emergency contact | Calls the nearest homes first on 6 lines and texts everyone nearby; tracks no answers and requests for help on the map | Simulated (fictional residents); real Retell calls and SMS planned |

## Data sources

| Use | Source | Notes |
|---|---|---|
| Terrain | USGS 3DEP | Analysis and simulation |
| Fuel | LANDFIRE FBFM40, Copernicus Sentinel-2 L2A (NDVI, NDMI) | Sentinel-2 revisits about every 5 days: periodic, not real time |
| Hotspots | NASA FIRMS (VIIRS 375 m), GOES-18 ABI FDC (2 km, every 5 min) | FIRMS arrives within about 3 hours |
| Wind | NOAA HRRR via Open-Meteo; WindNinja for terrain-adjusted wind | Free, no key |
| Buildings, roads | OpenStreetMap | — |
| Incident status | NIFC WFIGS (ignitions, perimeter), CAL FIRE incident updates | The official Norte perimeter (570 acres) replaced the coarse VIIRS-detected area once NIFC published it |

## What we learned about the real problem

1. **These hills are mostly grass, sage scrub and chaparral.** Fuel modelling needs type,
   continuity and moisture, not just tree density.
2. **Embers decide many outcomes.** Most homes lost in the 2025 Palisades and Eaton fires were
   ignited by embers. The model treats short-lived grass and scrub embers separately from rare
   lofted ones (the Norte Fire's second ignition, MIRADA, was a spot fire 2.4 km downwind). A
   150 m fuel break stops ordinary embers, but Santa Ana winds carry them across, which is why
   home hardening is one of the treatments.
3. **Only agencies such as CAL FIRE carry out prescribed burns.** This is a decision-support tool;
   it gives no orders.
4. **Alerts relay and amplify official evacuation orders.** The tool labels its own spread
   projections as unofficial.
5. **Residents' contact details come only from opt-in.** AI voice calls fall under the TCPA (the
   FCC ruled in 2024 that AI voices count as artificial voices); whether the emergency exemption
   applies needs legal review.

## Existing products

| Product | What it does | Relation to this project |
|---|---|---|
| Watch Duty | Nonprofit live fire app | Reference for live forwarding; we add 3D projection and treatment planning |
| Technosylva | Professional spread forecasting used by CAL FIRE | Professional-grade spread model |
| FlamMap / TOM | Fuel treatment optimization | Professional reference for planning; not built for the public |
| Genasys Protect, Alert LA County | Official evacuation zones and alerts | The authoritative source for alerts |
| ALERTCalifornia, Pano AI | Cameras plus AI early detection | Detection stage |

## Dual use

| Test | Answer |
|---|---|
| Ordinary day (who pays) | Treatment planning for utility vegetation management, county brush clearance, Fire Safe Councils and insurers |
| Crisis (3 a.m., network down) | The everyday ensemble runs build a library of wind × ignition scenarios; offline, the closest scenario for the current wind is ready |
| Migration (a tenth of the budget) | Sentinel-2, FIRMS and Copernicus elevation are free and global; moving to a new region means changing the bbox. Fuel maps, footprints and contact consent need local sources |

## Run locally

```bash
npm --prefix web ci
npm --prefix web run dev            # http://localhost:5173

cd server && uv run uvicorn app.main:app --port 8010   # optional backend: replay and dispatcher
```

Without a backend (as on the public site) the replay plays in the browser and the emergency
contact dispatcher runs in a Web Worker. Tests: `npm test` in `packages/core`, `pytest` in
`server` and `data-pipeline`.

## Hackathon

- Theme: Preparing for Disaster. Build dual-use solutions that keep working in a crisis, with an
  emphasis on resilience, efficiency and cost.
- Tracks: Marine, Energy (BASE), Communications (Retell), Ports. We built for resilient
  communications.
- Judging (1–5 each): dual-use fit, technical execution and MVP, feasibility and impact,
  response to the twists, demo and pitch.
- Entry: innovatelosangeles.com/dual-use; submissions: innovatela.devpost.com.

Experimental, unofficial model outputs. Demo contacts and calls are fictional. Always follow
official evacuation instructions.
