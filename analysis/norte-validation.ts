import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { downsample, remapCell, PlanningParams, SpreadParams } from '../packages/core/src/index.ts';
import { loadInputs, findRealGrid, detections, hourlyWinds, norte, ignitionMs, trainingPasses, testPasses, json } from './norte-inputs.ts';
import { hourlyArrivalSolver } from './norte-arrival.ts';

export function score(samples: { minutes: number; predicted: number }[]) {
  const paired = samples.filter(x => Number.isFinite(x.predicted));
  return { samples: samples.length, paired: paired.length, unreachable: samples.length - paired.length,
    detectionProxyMAEMinutes: paired.length ? paired.reduce((s, x) => s + Math.abs(x.predicted - x.minutes), 0) / paired.length : null,
    signedErrorMinutes: paired.length ? paired.reduce((s, x) => s + x.predicted - x.minutes, 0) / paired.length : null };
}
export function selectFit(results: { scale: number; training: ReturnType<typeof score> }[]) {
  // Do not reward a fit for making difficult observations unreachable.
  return [...results].filter(x => x.training.paired === x.training.samples && x.training.samples > 0)
    .sort((a, b) => a.training.detectionProxyMAEMinutes! - b.training.detectionProxyMAEMinutes!)[0] ?? null;
}
export function validateNorte(directory?: string, perimeterPath?: string) {
  const input = loadInputs(directory), { grid } = input;
  const coarse = downsample(grid, 4), ignition = remapCell(input.ignition, grid.meta.width, coarse.meta.width, 4);
  const observations = detections(grid);
  const samples = observations.kept.map(x => ({ ...x, coarseCell: remapCell(x.cell, grid.meta.width, coarse.meta.width, 4) }));
  const perimeter = perimeterPath ? json(perimeterPath) : null;
  const perimeterMinute = perimeter ? (Date.parse(perimeter.t) - ignitionMs) / 60000 : 0;
  if (perimeter && (!Number.isFinite(perimeterMinute) || perimeterMinute < 0)) throw Error('Invalid perimeter time');
  const winds = hourlyWinds(Math.max(540, perimeterMinute));
  if (perimeter && perimeterMinute > winds.at(-1)!.minute + 60) throw Error('Perimeter is beyond archived HRRR coverage');
  const solve = hourlyArrivalSolver(coarse, winds, grid.meta.cellSize);
  const scales = [...new Set([.1, .2, .3, PlanningParams.arrivalTimeScale, .4, .5, .75, 1, 1.5, 2])];
  const candidates = scales.map(scale => {
    const arrival = solve(ignition, scale);
    return { scale, training: score(samples.filter(x => x.split === 'train').map(x => ({ ...x, predicted: arrival[x.coarseCell] }))) };
  });
  const fit = selectFit(candidates), fittedArrival = fit ? solve(ignition, fit.scale) : null;
  const defaultArrival = solve(ignition, PlanningParams.arrivalTimeScale);
  const errorMap = samples.map(x => ({ ...x, defaultArrivalMinutes: Number.isFinite(defaultArrival[x.coarseCell]) ? defaultArrival[x.coarseCell] : null,
    fittedArrivalMinutes: fittedArrival && Number.isFinite(fittedArrival[x.coarseCell]) ? fittedArrival[x.coarseCell] : null,
    defaultSignedErrorMinutes: Number.isFinite(defaultArrival[x.coarseCell]) ? defaultArrival[x.coarseCell] - x.minutes : null,
    fittedSignedErrorMinutes: fittedArrival && Number.isFinite(fittedArrival[x.coarseCell]) ? fittedArrival[x.coarseCell] - x.minutes : null }));
  const heldOut = (arrival: Float64Array) => score(samples.filter(x => x.split === 'test').map(x => ({ ...x, predicted: arrival[x.coarseCell] })));
  let finalPerimeter: any = { status: 'pending', reason: 'No timestamped B3 perimeter/burn scar supplied. No final IoU is claimed.' };
  if (perimeterPath) {
    if (!directory) throw Error('Perimeter scoring requires the real B1 grid');
    const p = perimeter;
    if (!isDeepStrictEqual(p.gridMeta, grid.meta) || !p.source || !Array.isArray(p.cells))
      throw Error('Perimeter requires identical gridMeta, source and cells');
    const minute = (Date.parse(p.t) - ignitionMs) / 60000;
    if (!Number.isFinite(minute) || minute < 0 || p.cells.some((c: number) => !Number.isInteger(c) || c < 0 || c >= grid.meta.width * grid.meta.height))
      throw Error('Invalid perimeter timestamp or cells');
    const truth = new Set<number>(p.cells), predicted = new Set<number>();
    for (let c = 0; c < grid.meta.width * grid.meta.height; c++)
      if ((fittedArrival ?? defaultArrival)[remapCell(c, grid.meta.width, coarse.meta.width, 4)] <= minute) predicted.add(c);
    const intersection = [...truth].filter(c => predicted.has(c)).length, union = new Set([...truth, ...predicted]).size;
    finalPerimeter = { status: 'scored', source: p.source, t: p.t, iou: union ? intersection / union : 1,
      model: 'coarse deterministic arrival footprint upsampled; not GPU replay IoU' };
  }
  return {
    status: directory && fit ? 'provisional-detection-proxy-fit' : directory ? 'blocked-no-complete-fit' : 'blocked-missing-B1-B2; mock pipeline exercised',
    input: { source: input.source, gridMeta: grid.meta, ignition: norte, planningFactor: 4 },
    wind: { source: 'archived hourly HRRR centre point (index 12)', method: 'piecewise hourly expected-edge progress, FIFO; final hour held constant beyond archive window' },
    split: { trainingPasses, testPasses, excluded: observations.excluded },
    defaults: { arrivalTimeScale: PlanningParams.arrivalTimeScale, stepMinutes: SpreadParams.stepMinutes },
    candidates, selectedTrainingScale: fit?.scale ?? null,
    heldOut: { defaults: heldOut(defaultArrival), fitted: fittedArrival ? heldOut(fittedArrival) : null }, errorMap, finalPerimeter,
    recommendation: directory ? 'Provisional timing proxy only: do not change shared parameters without independent perimeter/CA validation. stepMinutes and arrivalTimeScale are confounded; keep stepMinutes=5 while fitting scale.' :
      'No Norte parameter recommendation from synthetic fuel/terrain. Keep shared defaults; rerun with B1 grid and B2 communities.',
    limitations: ['VIIRS acquisition times are delayed detections, not ignition times; signed early arrival is not necessarily an error.',
      'No assimilation of held-out hotspots or MIRADA as an ignition.', 'The hourly graph is an analysis proxy, not stochastic CA or verified evacuation timing.'],
  };
}
if (process.argv[1] === import.meta.filename) {
  const report = validateNorte(process.argv[2] ?? findRealGrid(), process.argv[3]);
  writeFileSync(resolve(import.meta.dirname, 'norte-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(report.status);
}
