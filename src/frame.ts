// How a page is shown: rotation and crop. Annotations and links are stored
// in the original page's coordinates (fractions 0..1), so changing the
// rotation or crop later never moves them relative to the music.

export type Rotation = 0 | 90 | 180 | 270;

export interface PageSetup {
  rot?: Rotation; // clockwise
  crop?: [number, number, number, number]; // left, top, right, bottom, as fractions of the rotated page
}

export const FULL: [number, number, number, number] = [0, 0, 1, 1];

export class Frame {
  readonly rot: Rotation;
  readonly crop: [number, number, number, number];

  // pw, ph: size in pixels of the whole, unrotated page at the current scale.
  constructor(
    setup: PageSetup | undefined,
    readonly pw: number,
    readonly ph: number,
  ) {
    this.rot = setup?.rot ?? 0;
    this.crop = setup?.crop ?? FULL;
  }

  // Whole page size once rotated.
  get rw() {
    return this.rot % 180 ? this.ph : this.pw;
  }

  get rh() {
    return this.rot % 180 ? this.pw : this.ph;
  }

  // Displayed (cropped) size.
  get width() {
    return this.rw * (this.crop[2] - this.crop[0]);
  }

  get height() {
    return this.rh * (this.crop[3] - this.crop[1]);
  }

  // Original page fraction → displayed pixel.
  map(u: number, v: number): [number, number] {
    const [ru, rv] = rotate(this.rot, u, v);
    return [(ru - this.crop[0]) * this.rw, (rv - this.crop[1]) * this.rh];
  }

  // Displayed pixel → original page fraction.
  unmap(x: number, y: number): [number, number] {
    const ru = x / this.rw + this.crop[0];
    const rv = y / this.rh + this.crop[1];
    return unrotate(this.rot, ru, rv);
  }
}

export function rotate(rot: Rotation, u: number, v: number): [number, number] {
  switch (rot) {
    case 90:
      return [1 - v, u];
    case 180:
      return [1 - u, 1 - v];
    case 270:
      return [v, 1 - u];
    default:
      return [u, v];
  }
}

export function unrotate(rot: Rotation, u: number, v: number): [number, number] {
  switch (rot) {
    case 90:
      return [v, 1 - u];
    case 180:
      return [1 - u, 1 - v];
    case 270:
      return [1 - v, u];
    default:
      return [u, v];
  }
}

// Bounding box of the ink on a rendered page (for automatic crop), as
// fractions, with a small margin. Returns null for a blank page.
export function inkBox(canvas: HTMLCanvasElement, margin = 0.015): [number, number, number, number] | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  // Sample every other pixel; ignore light greys (paper texture, scan dust).
  for (let y = 0; y < h; y += 2) {
    let row = false;
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 480 && data[i + 3] > 0) {
        row = true;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
    if (row) {
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) return null;
  return [
    Math.max(0, x0 / w - margin),
    Math.max(0, y0 / h - margin),
    Math.min(1, x1 / w + margin),
    Math.min(1, y1 / h + margin),
  ];
}
