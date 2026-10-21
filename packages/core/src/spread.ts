import type { Grid, Wind, WindField } from './types.ts';
import { SpreadParams as P, TreatmentEffect as E, PlanningParams as R } from './params.ts';
export function windAt(g: Grid, c: number, field: WindField): Wind {
    if ('speedMs' in field)
        return field;
    const { width: w, height: h, samples } = field;
    if (w < 1 || h < 1 || samples.length !== w * h)
        throw Error('Invalid wind field');
    const x = (c % g.meta.width) / Math.max(1, g.meta.width - 1) * (w - 1), y = Math.floor(c / g.meta.width) / Math.max(1, g.meta.height - 1) * (h - 1), x0 = Math.floor(x), y0 = Math.floor(y);
    let east = 0, north = 0;
    for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
            const s = samples[Math.min(h - 1, y0 + j) * w + Math.min(w - 1, x0 + i)], weight = (i ? x - x0 : 1 - x + x0) * (j ? y - y0 : 1 - y + y0), d = s.dirFromDeg * Math.PI / 180;
            east -= weight * s.speedMs * Math.sin(d);
            north -= weight * s.speedMs * Math.cos(d);
        }
    return { speedMs: Math.hypot(east, north), dirFromDeg: (Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360 };
}
/** Match the GPU CA's target-cell probability before clamping/treatment.
 * A coarse edge represents cellSize/referenceCellSize fine CA transitions.
 * Expected geometric waiting time is stepMinutes / p, not d / a second ROS model.
 */
export function surfaceProbability(g: Grid, u: number, v: number, wind: WindField): number {
    const d = g.data, o = v * 4;
    if (d[o + 3] !== 1 || d[o + 1] <= 0 || d[u * 4 + 3] === 0)
        return 0;
    const w = g.meta.width, dx = v % w - u % w, dy = Math.floor(v / w) - Math.floor(u / w);
    const distance = g.meta.cellSize * Math.hypot(dx, dy), s = windAt(g, v, wind);
    if (!Number.isFinite(s.speedMs) || s.speedMs < 0 || !Number.isFinite(s.dirFromDeg))
        throw Error('Invalid wind');
    const theta = s.dirFromDeg * Math.PI / 180;
    const cosine = (-Math.sin(theta) * dx + Math.cos(theta) * dy) / Math.hypot(dx, dy);
    const slope = Math.atan2(d[o] - d[u * 4], distance) * 180 / Math.PI;
    return P.ph * (.6 + .8 * d[o + 1]) * (.6 + .7 * d[o + 2]) * Math.exp(Math.max(-700, Math.min(700, P.c1 * s.speedMs + P.c2 * s.speedMs * (cosine - 1) + P.a * slope))) * (dx && dy ? .83 : 1);
}
export function treatmentMultiplier(code: number): number {
    return code === 1 ? E.break.fuelMul : code === 2 ? E.burn.fuelMul : code === 3 ? E.thin.rosMul : 1;
}
/** Fuel left in a burning source cell: a fire inside a fuel break or burn unit spreads and throws embers weakly (matches the CA). */
export function fuelRemaining(code: number): number {
    return code === 1 ? E.break.fuelMul : code === 2 ? E.burn.fuelMul : 1;
}
export function edgeMinutes(g: Grid, u: number, v: number, wind: WindField, mask: Uint8Array, options: import('./types.ts').ArrivalOptions = {}): number {
    const p = Math.min(1, surfaceProbability(g, u, v, wind) * treatmentMultiplier(mask[v]) * fuelRemaining(mask[u]));
    const reference = options.referenceCellSize ?? R.referenceCellSize, scale = options.timeScale ?? R.arrivalTimeScale;
    if (!(reference > 0) || !Number.isFinite(reference) || !(scale > 0) || !Number.isFinite(scale))
        throw Error('Invalid arrival scale');
    return p > 0 ? (g.meta.cellSize / reference) * P.stepMinutes * scale / p : Infinity;
}
