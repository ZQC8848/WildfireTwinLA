# Norte Fire: switching the demo from Eaton to south Orange County

Status: agreed direction as of 2026-10-17. Owner of this doc: Qinchuan (A).
Tasks: B (Tia) in issue "Norte Fire data: grid, replay and live feed"; C (Lucia) in issue "Norte Fire: calibration, ember spotting and Plan baseline".

## 1. Decision

The whole project now models one area: the **Norte Fire** in south Orange County (San Juan Capistrano / San Clemente), which started on 2026-10-16. Both modes run on the same area and the same grid:

- **Respond** is a replay of 2026-10-16 from ignition onward, driven by real public data. These are satellite hotspots, hourly HRRR wind, the two reported ignition points and the official evacuation orders. It ends with a comparison against the final perimeter.
- **Plan** is the counterfactual for the same area: "before 10-16, with this ignition point and this Santa Ana wind, where should fuel treatments go, and how many homes would they have saved?"
- **Live feed** stays. It polls FIRMS and Open-Meteo for the same bbox. The fire is mostly contained now, so the demo storyline is the replay, not live mode.

Why Norte instead of Eaton:

- Real timed data for Eaton never arrived (#11).
- For Norte, every input is public and already downloaded (section 4).
- The fire is about 2–3 km across, which fits our existing 512 × 25 m grid without any change to the frontend or the core.
- It contains a clean validation case for ember spotting (section 2).

Eaton support stays in the code (the `event=eaton` replay and the seed file) but is no longer the demo.

## 2. Incident facts (public sources, 2026-10-17)

| Item | Value | Source |
|---|---|---|
| Ignition (NORTE) | 2026-10-16 11:32:56 PDT, 33.479656, −117.634842 (near Portico Del Norte / Eminencia Del Norte, San Clemente) | NIFC WFIGS Incident Locations |
| Second ignition (MIRADA) | 2026-10-16 12:19:54 PDT, 33.476987, −117.661362. This is **2.4 km west, downwind**, 47 min after NORTE, so it is almost certainly an ember spot fire | NIFC WFIGS Incident Locations |
| Size and containment | 570 acres from 19:27 PDT on 10-16. Containment 0% (10-16 22:35), 5% (10-17 08:07), 25% (10-17 18:21), 50% (10-18 10:20 PDT) | CAL FIRE incident page, archived in `raw/calfire_updates_2026-10-18.json` |
| Knockdown | "Crews knocked down the majority of the fire by 5:45 p.m." (OCFA Capt. Steve Concialdi) | CBS Los Angeles |
| Damage | At least 6 homes damaged or destroyed, on Avenida Calita, Via La Mirada and Via De Agua (San Juan Capistrano) | OCFA via Fox LA |
| Evacuation orders | San Juan Capistrano zones SJC04, SJC05, SJC10 and San Clemente SCL12, SCL13. SCL13 and SJC10-B lifted at 12:18 PDT on 10-17; all others lifted at 18:00 PDT on 10-17. Via La Mirada stays closed to vehicles north of Esperanza and the burn scar is closed | CAL FIRE incident page |
| Wind at the fire (HRRR) | 10:00–15:00 PDT: 8–9 m/s from 67–89° (ENE), gusts 11–15 m/s, RH 16–20%. It weakens to 2–4 m/s after 17:00 | Open-Meteo `gfs_hrrr` |
| First satellite detections | VIIRS passes at 13:08 (NOAA-21, 15 px), 13:44 (S-NPP, 16 px), 14:04 (NOAA-20, 18 px) and 14:48 PDT (NOAA-21, 11 px). FRP is up to ~90 MW | NASA FIRMS NRT |
| False hotspot | A single weak night pixel at about 33.49, −117.618 on both 10-15 and 10-16, **before** ignition. This is the Prima Deshecha landfill, a static heat source that must be filtered | NASA FIRMS NRT |
| Official perimeter | 570.4 acres (230 ha), mapped 10-17 17:42 PDT, "Mixed Methods". Archived as `raw/wfigs_perimeter_2026-10-18.geojson` | NIFC WFIGS Interagency Perimeters |
| Heat after day one | No VIIRS detection within 2 km of the fire in any pass after 14:48 PDT on 10-16. The first pass that imaged the area with no heat at the fire was NOAA-20 at 02:26 PDT on 10-17 | NASA FIRMS NRT (7-day files, archived 10-18) |

Other fires nearby are out of scope: Henderson (Oceanside, 3,132 ac), an unnamed cluster near 33.35, −117.52 (San Diego County), and Bryson / Peak in LA County.

## 3. Area of interest

- Grid: 512 × 512 at 25 m, EPSG:32611 (unchanged). `cell = row * width + col`, row 0 north (unchanged).
- Target centre: 33.485, −117.645. Target WGS84 bbox: **`-117.714, 33.427, -117.576, 33.543`** (12.8 km square).
- Snap the UTM origin to whole 25 m metres in the pipeline. The frontend and backend read `bboxLonLat` and the origin from `grid.json` and assume nothing else.
- The bbox covers both ignition points, all of San Juan Capistrano, northern San Clemente, the south part of Ladera Ranch, Rancho Mission Viejo (Esencia) and the landfill.

## 4. Data sources

All of these were checked by calling the API on 2026-10-17.

| Data | Source | Notes |
|---|---|---|
| Elevation (simulation) | USGS 3DEP 1/3 arc-second (~10 m), TNM product `n34w118` (updated 2026-09-15) | A single seamless tile covers the bbox. Resample to 25 m |
| Elevation (close-up rendering, optional) | USGS 3DEP 1 m lidar tiles (CA SoCal Wildfires B1 2018, CA Gaps 2023) | 10 km tiles, so the bbox spans several of them. Display only, never used by the simulation |
| Vegetation, fuel, dryness | Sentinel-2 L2A from Planetary Computer, the last low-cloud scene **before 2026-10-16** | Existing pipeline |
| Fuel model (recommended) | LANDFIRE FBFM40, 30 m, free | Separates chaparral, coastal sage scrub and grass, which NDVI cannot |
| Burn scar (validation) | Sentinel-2 L2A, first low-cloud scene **after** the fire, minus the pre-fire scene, as dNBR | Ground truth if no official perimeter appears |
| Buildings | OSM Overpass (existing), with Microsoft US building footprints as a fallback | |
| Hotspots | FIRMS NRT VIIRS (S-NPP, NOAA-20, NOAA-21) plus MODIS; the area API needs a free MAP_KEY | The public 24h/48h CSVs need no key but roll off after 48 h |
| GOES | GOES-18 ABI FDC (existing direct decoder) | 2 km, every 5 min; fills the gap before the first polar pass |
| Wind and humidity | Open-Meteo `models=gfs_hrrr`, hourly, past days available | Archived for 10-15 to 10-17 already (below) |
| Incidents | NIFC WFIGS Incident Locations Current (ArcGIS REST) | NORTE and MIRADA records |
| Perimeter | NIFC WFIGS Interagency Perimeters Current | Poll until Norte appears |
| Evacuation zones | Genasys Protect | **Not public** (needs a signed agreement). Use approximate communities (B2) |

Raw files already archived in `data/norte/raw/`, because the FIRMS CSVs expire after 48 h:

- `firms_viirs_{J1,J2,N}_48h_2026-10-17.csv`: FIRMS NRT rows inside `-117.9, 33.3, -117.4, 33.7`. These are the original FIRMS columns, with `acq_time` as HHMM UTC.
- `wfigs_incidents_2026-10-17.json`: the NORTE and MIRADA records, with times in epoch ms.
- `hrrr_5x5_2026-10-15_17.json`: hourly HRRR (wind speed, direction, gusts, RH, temperature) at 5 × 5 points over the target bbox. Points are row-major from north to south and west to east, which is the core `WindField` order. Times are UTC.

## 5. Modules and owners

### B: Tia (data and backend)

**B1. Real grid for the Norte bbox.** This is the first priority, because the frontend has only ever run on the synthetic `?mock` grid.

- Run `wildfire-sentinel`, `wildfire-source dem`, `wildfire-source buildings` and `wildfire-grid` with the bbox from section 3.
- **Fix `fetch_dem`**. It currently asks for `Digital Elevation Model (DEM) 1 meter` with `max: 1`. That returns a single 10 km tile, which does not cover a 12.8 km bbox. Switch to `National Elevation Dataset (NED) 1/3 arc-second`, or download and mosaic every 1 m tile that intersects the bbox.
- Pick the Sentinel-2 scene **before** 2026-10-16 so the fuel is pre-fire.
- Optional but recommended: add LANDFIRE FBFM40 as an input and map it to `fuel` (0–1) and `class`. Grass and chaparral should differ.
- Commit the outputs (`grid.json`, `grid.bin`, `slope-aspect.bin`, `buildings.json`, `communities.json`, about 6 MB). Add `!web/public/data/*.json` and `!web/public/data/*.bin` exceptions to `.gitignore` so everyone loads the same data. Keep GeoTIFFs out of git.
- Acceptance: `npm --prefix web run dev` without `?mock` shows the San Juan Capistrano terrain. The info panel then says "Sentinel-2 and USGS".

**B2. Approximate communities.** Zone polygons are not public, so build the `communities.json` source GeoJSON from OSM residential landuse and neighbourhood boundaries. Cover at least:

- the neighbourhoods in SJC04 and SJC05 (the Avenida Calita / Via La Mirada / Via De Agua area);
- San Juan Hills / Stallion Ridge (SJC10);
- the northern San Clemente neighbourhoods next to the ignition (SCL12, SCL13);
- Ladera Ranch and Esencia, as controls upwind and to the side.

Use the real city names. Give each one an `approx: true` property, or put "approximate" in its name, so the UI never presents it as an official zone.

**B3. Norte replay generator** (`wildfire-norte-replay`, writing `server/data/norte-replay.jsonl`).

- Use the same event schema as `eaton-replay.jsonl`. Events in time order:
  - `snapshot` with `event: "norte"` and `dataset: "public-nrt-2026-10-16"`.
  - Ignition at 11:32:56 PDT: a `hotspots` event with one item at the NORTE origin, `source: "REPORT"`, `conf: 1`, `frp: 0`. Then the matching `incident` event.
  - The MIRADA spot fire at 12:19:54 PDT in the same form.
  - Hourly `wind` events from `data/norte/raw/hrrr_5x5_2026-10-15_17.json`. Please emit the core format `{width: 5, height: 5, samples: [{speedMs, dirFromDeg}]}`, with rows from north to south, instead of `grid5x5`. The frontend accepts both.
  - One `hotspots` event per satellite pass, with `emittedAt` set to the acquisition time. The four VIIRS passes are in section 2. Add any later passes from the FIRMS area API, which accepts a date parameter.
  - `official_order` events for SJC04, SJC05, SJC10, SCL12 and SCL13. Use the issue times from OCFA / City posts where you can find them, and state the source in each event. The frontend shows them as "Official".
  - The final `incident` event with `perimeterCells`, as the last event. Use the WFIGS perimeter once it is published; until then, use a dNBR burn scar from the first clear post-fire Sentinel-2 scene, labelled as such.
- **Static heat-source filter.** Drop detections within 750 m of the landfill point (33.4905, −117.6185) that occur outside the fire. Better, drop any pixel that also fired on several nights before 10-16. Apply the same filter in the live poller.
- Pacing: set `offsetSeconds = (t − ignition) / 5 minutes`, exactly **1 replay second per 5 real minutes**. The frontend runs the simulation on a replay clock built on this rule (`web/src/net/replayClock.ts`), so hotspots and wind land at the right simulation time. The server divides offsets by `speed` as it does now.
- Server: accept `event=norte` in `/ws?mode=replay` (the check at `server/app/main.py:232` currently only allows `eaton`). Make `norte` the default.
- Acceptance: the replay plays end to end against the real grid. The two ignitions land on the right streets, and the VIIRS pixels land on the burned hillside, not on the landfill.

**B4. Live feed for the new bbox.**

- Set the bbox in `server/app/config.py` (line 12).
- Configure a FIRMS MAP_KEY in `.env`, never in git.
- Apply the B3 static-source filter.

**B5. Optional: GOES-18 first detection.** Run the FDC decoder for 18:30–22:00 UTC on 10-16 and add those detections to the replay with `source: "GOES"`. That shows how early a geostationary satellite saw the fire compared with the first VIIRS pass at 13:08.

**B6. Optional: reported damage.** Mark the buildings on Avenida Calita, Via La Mirada and Via De Agua as `reportedDamageArea: true` in `buildings.json`. That is a street-level area, not a confirmed per-house list. The frontend will draw it as a comparison layer.

Issue #6 is implemented for this bbox by `wildfire-wind-library` and
`web/public/data/wind/`. Issue #11 (Eaton data) is superseded by this doc.

### C: Lucia (algorithms and validation)

**C1. Arrival-time check against VIIRS.**

- Inputs: the real grid (B1), ignition at NORTE at 11:32, and hourly HRRR wind (the centre point, or the 5 × 5 field).
- Compare the predicted arrival time at each VIIRS pixel with its detection time. `analysis/validate.py` already treats detection times as delayed proxies.
- **Hold out by time.** Fit with the 13:08 and 13:44 passes, and test on 14:04 and 14:48.
- Report whether `arrivalTimeScale` (currently 0.35, synthetic) and `stepMinutes` need a Norte value. Write the results to `analysis/norte-validation.json` with a short note.
- A burn scar or perimeter (B3) arrives later; then add the final IoU.

**C2. Ember spotting: can we reproduce MIRADA?** This is the most interesting validation point we have.

- With the current parameters, mean spotting distance is `distMeanPerWindMs × speed = 40 × 8.7 ≈ 350 m`. The distribution is lognormal with σ = 0.6 (`arrivalGraph.ts:51`). A 2.4 km jump is about 3.5 σ out, so its probability is about 2 × 10⁻⁴ per sample.
- Please quantify the probability of a spot ignition at or near the MIRADA cell within 50 minutes of ignition. Do this in the CPU arrival graph, and in the GPU CA if you can run it headless (see `analysis/ca-loader.mjs`).
- Then propose a Santa Ana adjustment: a heavier tail, a larger mean at high wind, or a separate long-range term. It must not make 3 m/s days unrealistic.
- Report it the same way, with the held-out check: the parameters must not be fitted to MIRADA and then tested on MIRADA alone.

**C3. Plan baseline for the Norte scenario.**

- Scenario: ignition at NORTE, wind 8.5 m/s from 75° (the 10-16 midday HRRR mean), horizon 480 min. Use the approximate communities from B2.
- Run greedy and min-cut at budgets of $20k, $40k and $80k.
- Report the metrics the frontend already shows: homes protected and treated hectares per type. Also report specifically whether the plans protect the reported damage area (B6) and SJC04 / SJC05.
- Save the results to `analysis/norte-plan-baseline.json`. The frontend Plan mode will default to this scenario, so the numbers should match what the UI shows (same `spread` options and horizon as in `web/src/planner/controller.ts`).

**C4. When the perimeter exists:** compute the final IoU and the arrival-time error map for the replay run, and add them to `analysis/norte-validation.json`.

### A: Qinchuan (frontend), for reference

Done on `a/norte-frontend`:

- The UI says Norte and requests `event=norte`.
- The frontend uses `server/data/norte-replay.jsonl`: both reported ignitions, four VIIRS passes with the landfill filtered out, hourly HRRR and official orders. `web/src/net/norteSeed.ts` remains only as a build-time fallback.
- The replay clock described in B3, and a pause at the end of the replay.
- Satellite vs model comparison. Before each pass is assimilated, it checks whether the model had already burned within 200 m of each pixel. Missed pixels turn blue. The panel shows "pixels the model had reached" and "model fire near a detection".
- Timeline ticks for satellite passes (blue) and reported ignitions (white).
- Plan defaults to the NORTE ignition and 8.5 m/s from 75°.
- The committed real grid is the default; the synthetic `?mock` grid remains a deliberate test fallback on the same bbox.

Still to do: the optional reported-damage layer (B6) and final-perimeter comparison once an
authoritative perimeter or post-fire dNBR product exists. Approximate community labels and the
real-grid integration are complete.

The UI requests `event=norte`, defaults Plan to the NORTE ignition and 10-16 wind, shows replay
timeline ticks and satellite/model comparison, and labels approximate communities. It must keep
the after-the-fact, non-official data disclaimer visible.

## 6. Contracts

Nothing in the frozen contracts in `docs/team-plan.md` changes. The additions are:

- The replay event name `norte`, with the file `server/data/norte-replay.jsonl`.
- Hotspot `source` may be `"REPORT"` for a reported ignition point, besides `VIIRS`, `MODIS` and `GOES`.
- Optional fields: `approx` on communities and `reportedDamageArea` on buildings.

The frontend ignores the server's `cell` for hotspots and recomputes it from `lon`/`lat`, so accurate coordinates and times are what matter. `perimeterCells` must use the same grid as `grid.json`.

## 7. Rules

- This is a non-official decision-support demo. Model alerts are never presented as evacuation orders. Official orders are shown only as received, with their source.
- Keys (FIRMS MAP_KEY, Retell, Tripo) live only in `.env`.
- No resident personal data. Building ids come from OSM; there are no addresses or names.
