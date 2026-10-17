import { buildArrivalGraph, travelMinutes } from '../packages/core/src/arrivalGraph.ts';
import type { Grid, WindField } from '../packages/core/src/index.ts';

// FIFO edge traversal: integrate expected progress through each hourly wind.
// Edge rates may change or disappear at a boundary; no backward-in-time shortcut.
export function integrateEdge(start: number, durations: number[], boundaries: number[], scale: number): number {
  let t = start, progress = 0;
  for (let i = 0; i < durations.length; i++) {
    const end = boundaries[i + 1] ?? Infinity;
    if (t >= end) continue;
    t = Math.max(t, boundaries[i]);
    const duration = durations[i] * scale;
    if (Number.isFinite(duration) && duration > 0) {
      const needed = (1 - progress) * duration;
      if (t + needed <= end) return t + needed;
      progress += (end - t) / duration;
    }
    t = end;
  }
  return Infinity;
}
export function hourlyArrivalSolver(grid: Grid, hours: { minute: number; wind: WindField }[], referenceCellSize = 25) {
  if (!hours.length || hours[0].minute > 0) throw Error('Missing wind at ignition');
  const n = grid.meta.width * grid.meta.height, mask = new Uint8Array(n);
  const edges: Map<string, { to: number; duration: number[] }>[] = Array.from({ length: n }, () => new Map());
  for (const [i, hour] of hours.entries()) {
    const graph = buildArrivalGraph(grid, hour.wind, { referenceCellSize, timeScale: 1, spotting: true });
    for (let u = 0; u < n; u++) for (const edge of graph.outgoing[u]) {
      const key = `${edge.to}:${edge.spotting}`;
      const item = edges[u].get(key) ?? { to: edge.to, duration: Array(hours.length).fill(Infinity) };
      item.duration[i] = travelMinutes(edge, mask, graph);
      edges[u].set(key, item);
    }
  }
  const boundaries = hours.map(x => x.minute);
  return (ignition: number, scale: number) => {
    const arrival = new Float64Array(n).fill(Infinity);
    const queue: [number, number][] = [];
    function push(c: number, t: number) {
      let i = queue.length; queue.push([c, t]);
      while (i && queue[(i - 1) >> 1][1] > t) { queue[i] = queue[(i - 1) >> 1]; i = (i - 1) >> 1; }
      queue[i] = [c, t];
    }
    function pop() {
      const result = queue[0], tail = queue.pop()!;
      if (queue.length) {
        let i = 0;
        while (2 * i + 1 < queue.length) {
          let j = 2 * i + 1;
          if (j + 1 < queue.length && queue[j + 1][1] < queue[j][1]) j++;
          if (queue[j][1] >= tail[1]) break;
          queue[i] = queue[j]; i = j;
        }
        queue[i] = tail;
      }
      return result;
    }
    arrival[ignition] = 0; push(ignition, 0);
    while (queue.length) {
      const [u, t] = pop(); if (t !== arrival[u]) continue;
      for (const edge of edges[u].values()) {
        const next = integrateEdge(t, edge.duration, boundaries, scale);
        if (next < arrival[edge.to]) { arrival[edge.to] = next; push(edge.to, next); }
      }
    }
    return arrival;
  };
}
