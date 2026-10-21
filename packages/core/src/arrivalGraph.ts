import type { ArrivalOptions, Grid, WindField } from './types.ts';
import { SpreadParams as P, TreatmentEffect, PlanningParams } from './params.ts';
import { neighbors } from './grid.ts';
import { fuelRemaining, surfaceProbability, treatmentMultiplier, windAt } from './spread.ts';
export interface TravelEdge {
    from: number;
    to: number;
    probability: number;
    spotting: boolean;
    steps: number;
    weight: number;
    minutes?: number[];
}
export interface ArrivalGraph {
    outgoing: TravelEdge[][];
    incomingSpot: TravelEdge[][];
    scale: number;
}
/** Deterministic proxy, NOT a stochastic CA or a probability forecast.
 * Representative upwind rays reproduce the CA's light-ember lognormal distances (dropping those past
 * the burnout distance) and +/-15° cone. The CA's rare lofted embers are not represented.
 * Sources inside fuel breaks and burn units are scaled by their remaining fuel when the mask is known.
 * A shortest path assumes an occupied upwind fire band; landing support is averaged
 * separately in building exposure. This intentionally cannot replace GPU validation.
 */
export function buildArrivalGraph(grid: Grid, wind: WindField, options: ArrivalOptions = {}): ArrivalGraph {
    const n = grid.meta.width * grid.meta.height;
    const reference = options.referenceCellSize ?? PlanningParams.referenceCellSize;
    const scale = options.timeScale ?? PlanningParams.arrivalTimeScale;
    if (!Number.isFinite(reference) || reference <= 0 || !Number.isFinite(scale) || scale <= 0)
        throw Error('Invalid arrival scale');
    const outgoing: TravelEdge[][] = Array.from({ length: n }, () => []), incomingSpot: TravelEdge[][] = Array.from({ length: n }, () => []);
    for (let v = 0; v < n; v++) {
        if (grid.data[v * 4 + 3] === 0)
            continue;
        for (const u of neighbors(grid, v)) {
            // CA permits diagonal neighbor spread; do not impose an extra CPU corner rule.
            const probability = surfaceProbability(grid, u, v, wind);
            if (probability > 0)
                outgoing[u].push({ from: u, to: v, probability, spotting: false, steps: grid.meta.cellSize / reference, weight: 1 });
        }
        const s = windAt(grid, v, wind);
        if (!Number.isFinite(s.speedMs) || s.speedMs < 0 || !Number.isFinite(s.dirFromDeg))
            throw Error('Invalid wind');
        if (options.spotting === false || s.speedMs <= 2 || P.spot.samples <= 0)
            continue;
        const theta = s.dirFromDeg * Math.PI / 180, x = v % grid.meta.width, y = Math.floor(v / grid.meta.width);
        const susceptibility = grid.data[v * 4 + 3] === 2 ? 2.5 * (.5 + grid.data[v * 4 + 2]) : grid.data[v * 4 + 1] * (.5 + grid.data[v * 4 + 2]);
        // Four lognormal quantile representatives, three angular bins (12 equal masses).
        const rays = new Map<number, number>();
        for (const z of [-1.150349, -.318639, .318639, 1.150349])
            for (const angle of [-10, 0, 10]) {
                const distance = P.spot.distMeanPerWindMs * s.speedMs * Math.exp(.6 * z - .18);
                if (distance > P.spot.distMaxPerWindMs * s.speedMs)
                    continue;
                const direction = theta + angle * Math.PI / 180;
                const xx = x + Math.round(Math.sin(direction) * distance / grid.meta.cellSize);
                const yy = y - Math.round(Math.cos(direction) * distance / grid.meta.cellSize);
                if (xx < 0 || xx >= grid.meta.width || yy < 0 || yy >= grid.meta.height)
                    continue;
                const u = yy * grid.meta.width + xx;
                if (u === v || grid.data[u * 4 + 3] === 0)
                    continue;
                rays.set(u, (rays.get(u) ?? 0) + 1 / 12);
            }
        for (const [u, weight] of rays) {
            const edge: TravelEdge = { from: u, to: v, probability: P.spot.pBase * susceptibility, spotting: true, steps: 1, weight };
            outgoing[u].push(edge);
            incomingSpot[v].push(edge);
        }
    }
    const graph = { outgoing, incomingSpot, scale };
    // Cache all five destination-treatment costs once per scenario, not per solve.
    for (const list of outgoing)
        for (const edge of list)
            edge.minutes = Array.from({ length: 5 }, (_, code) => uncachedMinutes(edge, code, scale));
    return graph;
}
function uncachedMinutes(edge: TravelEdge, code: number, scale: number, source = 1): number {
    const multiplier = treatmentMultiplier(code) * (edge.spotting && code === 4 ? TreatmentEffect.zone0.emberMul : 1) * source;
    const p = Math.max(0, Math.min(1, edge.probability * multiplier));
    const q = edge.spotting ? 1 - (1 - p) ** Math.min(8, P.spot.samples) : p;
    return q > 0 ? edge.steps * P.stepMinutes * scale / q : Infinity;
}
export function travelMinutes(edge: TravelEdge, mask: Uint8Array, graph: ArrivalGraph): number {
    // Cached by destination treatment; sources in fuel breaks or burn units are rare, so compute those on demand
    const source = fuelRemaining(mask[edge.from]);
    return source === 1 ? edge.minutes![mask[edge.to]] : uncachedMinutes(edge, mask[edge.to], graph.scale, source);
}
/** Expected ignition proxy from finite-lived, reachable upwind burning sources.
 * Quadrature mass, sample count and finite source lifetime matter here; unlike
 * shortest-path ETA, this is not an assumption that every sampled ray is burning.
 * Each source is evaluated once: repeated/hardened buildings in a cell share risk.
 */
export function buildingExposure(grid: Grid, cell: number, arrival: Float64Array, mask: Uint8Array, graph: ArrivalGraph, horizon: number, ignited: Set<number>): number {
    if (ignited.has(cell))
        return 1;
    if (grid.data[cell * 4 + 3] !== 2)
        return arrival[cell] <= horizon ? 1 : 0;
    let survival = 1;
    for (const edge of graph.incomingSpot[cell]) {
        const t = arrival[edge.from];
        const fuel = grid.data[edge.from * 4 + 1], sourceClass = grid.data[edge.from * 4 + 3];
        const lifetime = (sourceClass === 2 ? 8 : 2 + Math.round(3 * fuel)) * P.stepMinutes * graph.scale;
        const active = Math.min(lifetime, Math.max(0, horizon - t));
        if (!(active > 0))
            continue;
        const multiplier = (mask[cell] === 4 ? TreatmentEffect.zone0.emberMul : 1) * fuelRemaining(mask[edge.from]);
        // Coarse source cells stand in for a burning footprint, not independent replicas.
        const hit = Math.max(0, Math.min(1, edge.probability * multiplier * edge.weight));
        survival *= (1 - hit) ** (Math.min(8, P.spot.samples) * active / (P.stepMinutes * graph.scale));
    }
    return 1 - survival;
}
