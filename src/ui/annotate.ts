import type { Frame } from '../frame';
// Drawing of annotation items on a canvas laid over a rendered page.
// Coordinates are fractions of the page, so drawings scale with the page.

import type { AnnItem, Stroke } from '../model';

// Draw on a canvas laid over the displayed page. `frame` maps page fractions
// to canvas pixels (rotation, crop and scale included).
export function drawItems(ctx: CanvasRenderingContext2D, items: AnnItem[], frame: Frame) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const it of items) drawItem(ctx, it, frame);
}

export function drawItem(ctx: CanvasRenderingContext2D, it: AnnItem, frame: Frame) {
  ctx.save();
  if (it.t === 'stroke') {
    ctx.globalAlpha = it.alpha;
    ctx.strokeStyle = it.color;
    ctx.lineWidth = Math.max(1, it.width * frame.pw);
    ctx.lineCap = it.alpha < 1 ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p = it.pts;
    ctx.moveTo(...frame.map(p[0], p[1]));
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(...frame.map(p[i], p[i + 1]));
    if (p.length === 2) {
      const [x, y] = frame.map(p[0], p[1]);
      ctx.lineTo(x + 0.1, y);
    }
    ctx.stroke();
  } else {
    // Text stays upright on screen whatever the page rotation.
    const size = Math.max(8, it.size * frame.ph);
    ctx.fillStyle = it.color;
    ctx.textBaseline = 'top';
    ctx.font = `${it.t === 'stamp' ? 'bold italic ' : ''}${size}px "Noto Serif", Georgia, serif`;
    const [x, y] = frame.map(it.x, it.y);
    const lines = (it.t === 'text' ? it.text : it.symbol).split('\n');
    lines.forEach((line, i) => ctx.fillText(line, x, y + i * size * 1.2));
  }
  ctx.restore();
}

// Distance from a point to an item, in page fractions (for the eraser).
export function hits(it: AnnItem, x: number, y: number, r: number, aspect: number): boolean {
  if (it.t === 'stroke') return strokeHit(it, x, y, r, aspect);
  const size = it.size;
  const text = it.t === 'text' ? it.text : it.symbol;
  const lines = text.split('\n');
  const width = (Math.max(...lines.map((l) => l.length)) * size * 0.55) / aspect;
  const height = lines.length * size * 1.2;
  return x >= it.x - r && x <= it.x + width + r && y >= it.y - r && y <= it.y + height + r;
}

function strokeHit(s: Stroke, x: number, y: number, r: number, aspect: number) {
  const p = s.pts;
  const rr = r + s.width / 2;
  for (let i = 0; i < p.length - 2; i += 2) {
    if (segDist(x, y, p[i], p[i + 1], p[i + 2], p[i + 3], aspect) < rr) return true;
  }
  return p.length === 2 && Math.hypot(x - p[0], (y - p[1]) / aspect) < rr;
}

// y is scaled by 1/aspect so distances are in page-width units.
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number, aspect: number) {
  py /= aspect;
  ay /= aspect;
  by /= aspect;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Simplify a freshly drawn stroke (drops points closer than `eps`).
export function simplify(pts: number[], eps = 0.0015): number[] {
  if (pts.length <= 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    const lx = out[out.length - 2];
    const ly = out[out.length - 1];
    if (Math.hypot(pts[i] - lx, pts[i + 1] - ly) >= eps) out.push(pts[i], pts[i + 1]);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out.map((v) => Math.round(v * 1e5) / 1e5);
}

export const STAMPS = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'sfz', 'cresc.', 'dim.', 'rit.', 'tr', '♯', '♭', '♮', 'V', '⊓', '0', '1', '2', '3', '4', '𝄐', '//', '✓'];

export const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#111111', '#f59e0b', '#9333ea', '#ffffff'];
