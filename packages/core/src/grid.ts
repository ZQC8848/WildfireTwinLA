import type { Grid, GridMeta, Treatment } from "./types.ts";

export function cellIndex(meta: GridMeta, x: number, y: number): number {
  return y * meta.width + x;
}

export function cellXY(meta: GridMeta, cell: number): [number, number] {
  return [cell % meta.width, Math.floor(cell / meta.width)];
}

export function readGrid(meta: GridMeta, buffer: ArrayBuffer): Grid {
  if (
    meta.crs !== "EPSG:32611" ||
    !Number.isInteger(meta.width) ||
    !Number.isInteger(meta.height) ||
    meta.width < 1 ||
    meta.height < 1 ||
    !(meta.cellSize > 0)
  ) {
    throw Error("Invalid grid metadata");
  }
  if (buffer.byteLength !== meta.width * meta.height * 16) {
    throw Error("Expected four little-endian float32 values per cell");
  }
  const view = new DataView(buffer);
  const data = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = view.getFloat32(i * 4, true);
    if (!Number.isFinite(data[i])) throw Error("Nonfinite grid value");
  }
  for (let i = 0; i < data.length; i += 4) {
    if (
      data[i + 1] < 0 ||
      data[i + 1] > 1 ||
      data[i + 2] < 0 ||
      data[i + 2] > 1 ||
      ![0, 1, 2].includes(data[i + 3])
    ) {
      throw Error("Invalid fuel, dryness or class");
    }
  }
  return { meta, data };
}

export const treatmentCode = { break: 1, burn: 2, thin: 3, zone0: 4 } as const;

export function treatmentMask(n: number, treatments: Treatment[]): Uint8Array {
  const mask = new Uint8Array(n);
  for (const treatment of treatments) {
    for (const cell of treatment.cells) {
      if (cell >= n) throw Error("Treatment out of bounds");
      if (mask[cell] && mask[cell] !== treatmentCode[treatment.type]) {
        throw Error("Conflicting treatments");
      }
      mask[cell] = treatmentCode[treatment.type];
    }
  }
  return mask;
}

export function neighbors(grid: Grid, cell: number): number[] {
  const { width, height } = grid.meta;
  const x = cell % width;
  const y = Math.floor(cell / width);
  const result: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) {
        result.push((y + dy) * width + x + dx);
      }
    }
  }
  return result;
}

// Block diagonal corner cutting across nonburnable orthogonal neighbors.
export function canStep(grid: Grid, from: number, to: number): boolean {
  const width = grid.meta.width;
  const dx = (to % width) - (from % width);
  const dy = Math.floor(to / width) - Math.floor(from / width);
  return !dx || !dy || Boolean(grid.data[(from + dx) * 4 + 3] && grid.data[(from + dy * width) * 4 + 3]);
}

export function downsample(grid: Grid, factor: number): Grid {
  if (
    !Number.isInteger(factor) ||
    factor < 1 ||
    grid.meta.width % factor ||
    grid.meta.height % factor
  ) {
    throw Error("Factor must divide dimensions");
  }
  const width = grid.meta.width / factor;
  const height = grid.meta.height / factor;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const classes = [0, 0, 0];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const source = ((y * factor + dy) * grid.meta.width + x * factor + dx) * 4;
          const destination = (y * width + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            data[destination + channel] += grid.data[source + channel] / (factor * factor);
          }
          classes[grid.data[source + 3]]++;
        }
      }
      data[(y * width + x) * 4 + 3] = classes[2] ? 2 : classes[1] ? 1 : 0;
    }
  }
  return {
    meta: {
      ...grid.meta,
      width,
      height,
      cellSize: grid.meta.cellSize * factor,
    },
    data,
  };
}

export function remapCell(
  cell: number,
  sourceWidth: number,
  targetWidth: number,
  factor: number,
): number {
  return Math.floor(Math.floor(cell / sourceWidth) / factor) * targetWidth + Math.floor((cell % sourceWidth) / factor);
}

export function upsampleMask(
  mask: Uint8Array,
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  if (mask.length !== width * height || !Number.isInteger(factor) || factor < 1) {
    throw Error("Invalid mask or factor");
  }
  const output = new Uint8Array(width * height * factor * factor);
  for (let y = 0; y < height * factor; y++) {
    for (let x = 0; x < width * factor; x++) {
      output[y * width * factor + x] = mask[Math.floor(y / factor) * width + Math.floor(x / factor)];
    }
  }
  return output;
}
