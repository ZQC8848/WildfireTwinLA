import type { Grid, CoreOptions, WindField, WindScenario, PlanRequest, Treatment, TreatmentType, Metrics, PlannerDiagnostics } from './types.ts';
import { PlanningParams } from './params.ts';
import { treatmentMask, treatmentCode } from './grid.ts';
import { shortestPaths, pathFlow } from './dijkstra.ts';
import { minCutBaseline } from './mincut.ts';
import { buildArrivalGraph, buildingExposure } from './arrivalGraph.ts';
const names: TreatmentType[] = ['break', 'burn', 'thin', 'zone0'];
const EPS = 1e-9;
export function createCore(grid: Grid, options: CoreOptions = {}) {
    const n = grid.meta.width * grid.meta.height, buildings = options.buildings ?? [];
    const cost = options.cost ?? ((type: TreatmentType) => PlanningParams.costPerCell[type]);
    const limit = options.candidateLimit ?? 24, maxIterations = options.maxIterations ?? 20;
    const lengths = [...new Set([options.stripLength ?? 5, ...(options.stripLengths ?? [11, 21])])];
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxIterations) || maxIterations < 0 || lengths.some(l => !Number.isInteger(l) || l < 1 || l % 2 === 0))
        throw Error('Invalid planner search options');
    for (const b of buildings)
        if (!Number.isInteger(b.cell) || b.cell < 0 || b.cell >= n || !Number.isFinite(b.weight) || b.weight < 0)
            throw Error('Invalid building');
    const grouped = new Map<number, {
        cell: number;
        weight: number;
        count: number;
    }>();
    for (const b of buildings) {
        const group = grouped.get(b.cell) ?? { cell: b.cell, weight: 0, count: 0 };
        group.weight += b.weight;
        group.count++;
        grouped.set(b.cell, group);
    }
    const targetsByCell = [...grouped.values()];
    const allowed = (type: TreatmentType, c: number) => (type === 'zone0' ? grid.data[c * 4 + 3] === 2 : grid.data[c * 4 + 3] === 1) && (options.allowed?.(type, c) ?? true);
    function cellCost(type: TreatmentType, c: number) {
        const v = cost(type, c);
        if (!Number.isFinite(v) || v <= 0)
            throw Error('Cost must be finite and positive');
        return v;
    }
    function scenarios(s: WindScenario[]) {
        if (!s.length || s.some(x => !Number.isFinite(x.probability) || x.probability < 0 || !Number.isFinite(x.horizonMinutes) || x.horizonMinutes < 0) || s.reduce((a, x) => a + x.probability, 0) <= 0)
            throw Error('Invalid scenarios');
        const sum = s.reduce((a, x) => a + x.probability, 0);
        return s.filter(x => x.probability > 0).map(x => ({ ...x, probability: x.probability / sum, graph: buildArrivalGraph(grid, x.wind, options.spread), ignited: new Set(x.ignitions) }));
    }
    type Scenarios = ReturnType<typeof scenarios>;
    function computeArrival(ignitions: number[], wind: WindField, mask: Uint8Array): Float32Array { return Float32Array.from(shortestPaths(grid, ignitions, wind, mask, options.spread).arrival); }
    function assess(mask: Uint8Array, ss: Scenarios, withFlow = false) {
        let weighted = 0, threatened = 0, area = 0, objective = 0;
        const flow = new Float64Array(n), risks = new Float64Array(n), trees: Int32Array[] = [];
        for (const s of ss) {
            const p = shortestPaths(grid, s.ignitions, s.wind, mask, options.spread, s.graph), targets: {
                cell: number;
                weight: number;
            }[] = [];
            trees.push(p.parent);
            for (const b of targetsByCell) {
                const risk = buildingExposure(grid, b.cell, p.arrival, mask, s.graph, s.horizonMinutes, s.ignited);
                weighted += s.probability * b.weight * risk;
                threatened += s.probability * risk * b.count;
                risks[b.cell] += s.probability * b.weight * risk;
                // Small continuous tie-breaker crosses binary loss plateaus by rewarding delay.
                // Candidate acceptance below also requires non-increasing primary weighted risk.
                const timely = Number.isFinite(p.arrival[b.cell]) ? 1 / (1 + p.arrival[b.cell] / Math.max(1, s.horizonMinutes)) : 0;
                objective += s.probability * b.weight * risk * (1 + .05 * timely);
                if (risk > EPS)
                    targets.push({ cell: b.cell, weight: b.weight * risk });
            }
            if (withFlow) {
                const f = pathFlow(p.parent, p.order, targets);
                for (let c = 0; c < n; c++)
                    flow[c] += s.probability * f[c];
            }
            for (let c = 0; c < n; c++)
                if (p.arrival[c] <= s.horizonMinutes)
                    area += s.probability * grid.meta.cellSize ** 2 / 10000;
        }
        return { weighted, threatened, area, objective, flow, risks, trees };
    }
    function maskCost(mask: Uint8Array) {
        let total = 0;
        for (let c = 0; c < n; c++)
            if (mask[c])
                total += cellCost(names[mask[c] - 1], c);
        return total;
    }
    function evaluate(mask: Uint8Array, s: WindScenario[]): Metrics {
        const ss = scenarios(s), after = assess(mask, ss), before = assess(new Uint8Array(n), ss), total = maskCost(mask);
        return { buildingsThreatened: after.threatened, burnedAreaHa: after.area, cost: total, lossPerDollar: total ? (before.weighted - after.weighted) / total : 0 };
    }
    let diagnostics: PlannerDiagnostics = { iterations: 0, spent: 0, stopReason: 'no-beneficial-candidate', evaluatedCandidates: 0 };
    function planTreatments(req: PlanRequest): Treatment[] {
        if (!Number.isFinite(req.budget) || req.budget < 0)
            throw Error('Invalid budget');
        const ss = scenarios(req.scenarios), initial = treatmentMask(n, req.fixed);
        for (let c = 0; c < n; c++)
            if (initial[c] && !allowed(names[initial[c] - 1], c))
                throw Error('Fixed treatment prohibited');
        let mask = initial, spent = maskCost(mask);
        if (spent > req.budget)
            throw Error('Fixed treatments exceed budget');
        // Canonicalize duplicate fixed cells and costs so the returned sum matches masks.
        const out: Treatment[] = [], seen = new Set<number>();
        for (const t of req.fixed) {
            const cells = Uint32Array.from([...t.cells].filter(c => {
                if (seen.has(c))
                    return false;
                seen.add(c);
                return true;
            }));
            if (cells.length)
                out.push({ ...t, cells, cost: [...cells].reduce((a, c) => a + cellCost(t.type, c), 0) });
        }
        diagnostics = { iterations: 0, spent, stopReason: 'iteration-limit', evaluatedCandidates: 0 };
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            const before = assess(mask, ss, true), remaining = req.budget - spent;
            if (remaining <= EPS) {
                diagnostics.stopReason = 'budget-exhausted';
                break;
            }
            const ranked = Array.from({ length: n }, (_, c) => c).filter(c => !mask[c] && grid.data[c * 4 + 3] === 1 && before.flow[c] > EPS)
                .sort((a, b) => before.flow[b] / cellCost('break', b) - before.flow[a] / cellCost('break', a));
            // Reserve half the centers for spatial coverage; a single upstream path must not
            // monopolize all candidates. Recompute flows after every accepted treatment.
            const centerLimit = Math.max(96, limit * 2);
            const centers = ranked.slice(0, Math.ceil(centerLimit / 2)), bins = new Set<number>();
            const binSize = Math.max(1, Math.ceil(Math.sqrt(n / centerLimit))), binWidth = Math.ceil(grid.meta.width / binSize);
            for (const c of centers)
                bins.add(Math.floor(c % grid.meta.width / binSize) + Math.floor(Math.floor(c / grid.meta.width) / binSize) * binWidth);
            for (const c of ranked) {
                if (centers.length >= centerLimit)
                    break;
                const bin = Math.floor(c % grid.meta.width / binSize) + Math.floor(Math.floor(c / grid.meta.width) / binSize) * binWidth;
                if (!bins.has(bin)) {
                    centers.push(c);
                    bins.add(bin);
                }
            }
            // Fill spare slots when all high-flow cells happen to lie in the same bin.
            for (const c of ranked)
                if (centers.length < centerLimit && !centers.includes(c))
                    centers.push(c);
            const candidates: {
                t: Treatment;
                priority: number;
            }[] = [], keys = new Set<string>();
            function add(type: TreatmentType, cells: number[], priority: number) {
                const unique = [...new Set(cells)].filter(c => !mask[c] && allowed(type, c)).sort((a, b) => a - b);
                const price = unique.reduce((a, c) => a + cellCost(type, c), 0), key = type + ':' + unique.join(',');
                if (!unique.length || price > remaining + EPS || keys.has(key))
                    return;
                keys.add(key);
                candidates.push({ t: { type, cells: Uint32Array.from(unique), cost: price, source: 'greedy' }, priority });
            }
            // Each wind's path direction can produce a different useful strip.
            for (const c of centers)
                for (const tree of before.trees) {
                    const p = tree[c];
                    if (p < 0)
                        continue;
                    const w = grid.meta.width, dx = c % w - p % w, dy = Math.floor(c / w) - Math.floor(p / w);
                    // Spotting parents can be far away. Normalize to a grid-axis/diagonal strip.
                    const sx = -Math.sign(dy), sy = Math.sign(dx);
                    for (const length of lengths) {
                        const cells: number[] = [];
                        for (let k = -Math.floor(length / 2); k <= Math.floor(length / 2); k++) {
                            const x = c % w + k * sx, y = Math.floor(c / w) + k * sy;
                            if (x >= 0 && x < w && y >= 0 && y < grid.meta.height)
                                cells.push(y * w + x);
                        }
                        for (const type of ['break', 'burn', 'thin'] as TreatmentType[])
                            add(type, cells, before.flow[c] / cellCost(type, c));
                    }
                }
            // Building-cell costs are charged once even if multiple homes share the cell.
            const homes = [...new Set(buildings.map(b => b.cell))].filter(c => !mask[c] && allowed('zone0', c) && before.risks[c] > EPS)
                .sort((a, b) => before.risks[b] / cellCost('zone0', b) - before.risks[a] / cellCost('zone0', a));
            for (const c of homes.slice(0, centerLimit))
                add('zone0', [c], before.risks[c] / cellCost('zone0', c));
            // Bundles prevent maxIterations=8 from limiting hardening to only eight cells.
            const affordable: number[] = [];
            let bundleCost = 0;
            for (const c of homes)
                if (bundleCost + cellCost('zone0', c) <= remaining + EPS) {
                    affordable.push(c);
                    bundleCost += cellCost('zone0', c);
                }
            for (const size of [4, 16, 64, affordable.length])
                if (size > 0 && size <= affordable.length)
                    add('zone0', affordable.slice(0, size), 1);
            // Screen cheaply before exact solves; preserve each treatment/length family.
            // Run all candidates on small fixtures, bounded diverse sampling on large grids.
            function shortlist(pool: typeof candidates, quota: number) {
                const families = new Map<string, typeof candidates>();
                for (const candidate of pool) {
                    const key = candidate.t.type + ':' + candidate.t.cells.length;
                    const group = families.get(key) ?? [];
                    group.push(candidate);
                    families.set(key, group);
                }
                for (const [key, family] of families) {
                    family.sort((a, b) => b.priority - a.priority);
                    const bins = new Set<number>(), diverse: typeof candidates = [], rest: typeof candidates = [];
                    for (const item of family) {
                        const c = item.t.cells[Math.floor(item.t.cells.length / 2)], bin = Math.floor(c % grid.meta.width / binSize) + Math.floor(Math.floor(c / grid.meta.width) / binSize) * binWidth;
                        if (bins.has(bin))
                            rest.push(item);
                        else {
                            bins.add(bin);
                            diverse.push(item);
                        }
                    }
                    families.set(key, [...diverse, ...rest]);
                }
                const result: typeof candidates = [];
                for (let row = 0; result.length < quota; row++) {
                    let added = false;
                    for (const family of families.values())
                        if (family[row] && result.length < quota) {
                            result.push(family[row]);
                            added = true;
                        }
                    if (!added)
                        break;
                }
                return result;
            }
            const land = candidates.filter(c => c.t.type !== 'zone0'), hardening = candidates.filter(c => c.t.type === 'zone0');
            // Reserve exact solves for hardening as well as strips, so a high-flow land
            // corridor cannot hide all building candidates. Total solves stay bounded.
            const zoneQuota = hardening.length ? land.length ? Math.ceil(limit / 2) : limit : 0;
            const selected = [...shortlist(hardening, zoneQuota), ...shortlist(land, limit - zoneQuota)];
            const remainingCandidates = candidates.filter(c => !selected.includes(c));
            const fallback = shortlist(remainingCandidates, limit * 3);
            const search = [...selected, ...fallback];
            let best: Treatment | undefined, bestScore = 0, bestGain = 0;
            for (let candidateIndex = 0; candidateIndex < search.length; candidateIndex++) {
                // Only widen exact search if the first diverse batch has no gain.
                if (candidateIndex === selected.length && best)
                    break;
                const { t } = search[candidateIndex];
                const candidate = mask.slice();
                for (const c of t.cells)
                    candidate[c] = treatmentCode[t.type];
                const after = assess(candidate, ss);
                diagnostics.evaluatedCandidates++;
                if (after.weighted > before.weighted + EPS)
                    continue;
                const gain = before.objective - after.objective, score = gain / t.cost;
                if (score > bestScore + 1e-12 || (score > 0 && Math.abs(score - bestScore) <= 1e-12 && gain > bestGain)) {
                    best = t;
                    bestScore = score;
                    bestGain = gain;
                }
            }
            if (!best || bestGain <= EPS) {
                diagnostics.stopReason = 'no-beneficial-candidate';
                break;
            }
            out.push(best);
            spent += best.cost;
            for (const c of best.cells)
                mask[c] = treatmentCode[best.type];
            diagnostics.iterations++;
            diagnostics.spent = spent;
            if (req.budget - spent <= EPS) {
                diagnostics.stopReason = 'budget-exhausted';
                break;
            }
        }
        return out;
    }
    function planMinCut(ignitions: number[]) { return minCutBaseline(grid, ignitions, buildings.map(b => b.cell), c => cellCost('break', c), c => allowed('break', c)); }
    return { computeArrival, planTreatments, evaluate, planMinCut, getPlannerDiagnostics: () => ({ ...diagnostics }) };
}
