# WildfireTwinLA demo video script (2:30)

- **Goal:** show every critical part of the system working, in 150 seconds:
  - the public-data replay;
  - the fire model;
  - the contact pipeline (queue, lines, outcomes, map link, no-answer handling);
  - the 64-run forecast;
  - prevention planning.
- **Rule:** the Hub requires the demo video to be under 3:00.
- **Narration:** about 330 words at a calm pace (about 2.2 words per second).
- **Recording:** record the screen first, then add the voice-over and captions in editing. The timings assume small cuts where the app is computing.

## 1. Before recording

### Machine and app

1. Use real Chrome on the Mac, not headless; the GPU matters. Set the window to 1920×1080 or full screen, browser zoom 100%. Hide the bookmarks bar, close other tabs, and turn on Do Not Disturb.
2. Start both servers:
   - backend: `cd server && uv run uvicorn app.main:app --port 8010`
   - frontend: `npm --prefix web run dev`
   - Open http://localhost:5173.
3. Before **every take**, reset the dispatcher with `curl -X POST localhost:8010/api/v1/dispatch/stop`, then reload the page.
4. **Call speed.** At the default ×10, call outcomes stay on a line card for only about 1.5 s. For the video, ×4 is easier to read. Run this once before reloading the page:

   ```
   curl -X POST localhost:8010/api/v1/dispatch/start -H 'Content-Type: application/json' -d '{"demo_speed":4}'
   curl -X POST localhost:8010/api/v1/dispatch/stop
   ```

   The panel will then honestly show "demo ×4".
5. Do one full dry run before recording, so the terrain, wind library and models are cached.

### Known issue for segment 5

If no test fire is placed, "Suggest plans and compare" returns **0 homes and 0 ha for every plan**. The default scenario ignites a single unburnable cell.

So always click a vegetated hillside to place a test fire before you compare (step 5c). The comparison takes about 30 s on the GPU; cut that wait in editing.

### Retell

The Hub asks videos that used Retell to show the prompts. This demo places **no Retell calls**: every call is simulated, so this does not apply. If the team configures a real Retell agent later, add about 10 s showing the agent prompt.

## 2. Script

Captions are short lower-thirds added in editing. The status labels in capitals (REPLAY, SIMULATED CONTACT, MODELLED) must appear whenever that kind of content is on screen.

### 0:00–0:12 · Hook (12 s)

**Screen**
- Respond mode, Overview (key `1`), before starting the replay.
- Slow orbit: drag gently with the mouse.

**Narration**
> During a wildfire, a few phone lines must reach thousands of households. WildfireTwinLA helps decide who to contact first — and helps communities prepare before the next fire.

**Caption:** WildfireTwinLA · Norte Fire study area, San Clemente / San Juan Capistrano

### 0:12–0:35 · Public-data replay and fire model (23 s)

**Screen**
1. Left panel → Data source → **Norte replay**. The reported ignition appears and the fire starts to spread.
2. Press `2` (Fire front). Make sure **Satellite hotspots** is on; the orange columns are VIIRS detections.
3. Hold briefly on the left panel numbers: "Pixels the model had reached", "Model fire near a detection".
4. The contact panel opens on the right by itself. Ignore it until the next segment.

**Narration**
> This is the Norte Fire of October 16, replayed from public data: the reported ignition, NASA VIIRS satellite detections and archived NOAA wind. It is a replay, not a live feed. Our GPU fire model spreads over real terrain and fuels, and we score it against every satellite pass.

**Caption:** REPLAY · NIFC ignition records · NASA FIRMS VIIRS · NOAA HRRR wind

### 0:35–0:57 · Who gets called first (22 s)

**Screen**
1. Press `1` (Overview) so the map and the contact panel are both visible.
2. Point the cursor, in order, at:
   - the **Calls / Texts** progress bars;
   - the six **Lines** (ringing and "On the call" timers);
   - the **Queue** (Calls tab): rank, masked address, resident, "Access needs" tag, arrival time.

**Narration**
> As soon as fire appears, the contact pipeline starts. Every nearby home gets an estimated fire-arrival time from distance, wind and the model, and the queue calls the earliest first. Residents flagged with access needs move up. Six lines call in parallel; everyone nearby also gets a text.

**Caption:** SIMULATED CONTACT · fictional residents, (949) 555-01xx numbers

### 0:57–1:12 · Map and list stay in sync (15 s)

**Screen**
1. Hover **queue row 1**; its house is highlighted on the map.
2. Click it; the camera flies to the house. Turn **Satellite hotspots** off for close-ups, because the columns block the view.
3. Show the pink rings above roofs. Then click a **line card that is "On the call"**; the camera flies to that house, which has a pulsing pink outline.

**Narration**
> Each home's status sits above its own roof: queued, on a call, confirmed safe. The home on a call is outlined, so the map and the list always point at the same house.

### 1:12–1:30 · No answer, and needs help (18 s)

**Screen**
1. Wait for a line card to show "✓ Confirmed safe", then one showing "✕ No answer, retry later". At ×4 each result stays about 4 s.
2. Point at a queue row with the **Retry** tag.
3. Point at the **Needs help** list.
4. Click a white "!" help bubble on the map; the panel scrolls to that resident and outlines the card.

**Narration**
> No answer does not mean safe. We retry after three minutes, then move that household's text to the front. Anyone who asks for help stays pinned at the top for a person to follow up.

**Caption:** SIMULATED CONTACT · retry and text fallback simulated; reply capture planned

### 1:30–1:45 · 64-run forecast (15 s)

**Screen**
1. Press `1` (Overview).
2. Left panel → Forecast, next 8 hours → **Run 64-run forecast**. Keep **Show on map** checked.
3. The probability shading and hourly arrival lines appear. Point at the community table (Chance / Median / Earliest).

**Narration**
> A 64-run forecast varies wind direction and speed to show where the fire may reach in eight hours, and when — and those arrival times feed straight into the call queue.

**Caption:** MODELLED · 64 runs · wind ±15°, speed ±20% · not an official prediction

### 1:45–2:15 · Prevention planning (30 s)

Do this segment in a **separate take** and join it in editing.

**Screen**
1. **a.** Click **Reset**, switch to **Plan**. The theme changes to day.
2. **b.** Treatments → **Fuel break**. Drag a short line on the hillside west-southwest (downwind) of the Norte ignition, then press `Esc`. The panel shows the area and cost (about $25k).
3. **c.** With no tool selected, click a vegetated hillside next to the Norte ignition to place a test fire. Click **Pause** so the map stays calm.
4. **d.** Click **Suggest plans and compare**. **Cut the wait (about 30 s).**
5. **e.** Show the table: None / Yours / Greedy / Min-cut, with Homes reached, Area burned and Cost. Point at "≈ 0" and the line "Differences under N homes are within run-to-run noise."
6. **f.** Click the **Yours** and **Greedy** column headers to switch the plan shown on the map.

**Narration**
> On an ordinary day, the same map serves community planners. We draw a fuel break, set a test fire near the Norte ignition point, and compare it against no treatment and two algorithm plans — five simulation runs each. Our break is within run-to-run noise, and the app says so: approximately zero, not homes saved.

**Caption:** MODELLED · same ignition and wind · 8 h · 5 runs per plan

> On our last run: None 419 · Yours 422 · Greedy 389 buildings reached, noise ±58. Your numbers will differ slightly, so read them off the screen. Never narrate a number the screen does not show.

### 2:15–2:30 · Close (15 s)

**Screen**
- Back to the Respond overview with the contact panel open, or a title card with the repository link and QR code.

**Narration**
> Real public data, a working fire simulator, and an outreach pipeline ready for Retell voice calls. Prepare before the fire; prioritize outreach during it.

**Caption:** github.com/ZQC8848/WildfireTwinLA · Experimental, unofficial model outputs. Demo contacts and calls are fictional. Follow official evacuation instructions.

## 3. Coverage check

| Critical part | Where in the video | Status label on screen |
|---|---|---|
| Public-data replay (ignition, VIIRS, HRRR) and model-vs-satellite score | 0:12 | REPLAY |
| GPU fire spread on real terrain and fuels | 0:12–0:35 | MODELLED (in narration) |
| Contact queue ranked by estimated arrival, access needs | 0:35 | SIMULATED CONTACT |
| Six parallel lines, call outcomes | 0:35, 1:12 | SIMULATED CONTACT |
| Map ↔ list link: hover, fly-to, roof markers, outline, bubble → panel | 0:57, 1:12 | — |
| No answer → retry → text; needs help | 1:12 | SIMULATED CONTACT; reply capture PLANNED |
| 64-run ensemble forecast feeding the queue | 1:30 | MODELLED |
| Treatments, plan comparison, noise label | 1:45 | MODELLED |
| What is real, simulated, planned; responsible use | 2:15 | footer caption |

## 4. Editing notes

- Keep the total at or under 2:30. If it runs long, trim the 0:57 segment first; the map link is also visible in other segments.
- Never speed up the replay without a "2× speed" label. Mark cut waits with a quick dissolve, not a hard cut, so nothing looks staged.
- Do not show the **Live feed** button as working. It is not configured, and live mode shows an empty map.
- If outcomes flash by too fast, record at ×4 (see setup step 4) rather than slowing the footage.
