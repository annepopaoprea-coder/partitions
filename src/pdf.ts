// Page rendering for PDF and image files.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Frame, type PageSetup, type Rotation } from './frame';
import { blobName, type Song } from './model';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Doc {
  pages: number;
  size(page: number): Promise<{ w: number; h: number }>;
  // Draw the whole page, turned clockwise by `rot`, at `scale` pixels per point.
  draw(page: number, canvas: HTMLCanvasElement, scale: number, rot: Rotation): Promise<void>;
}

const cache = new Map<string, Promise<Doc>>();

async function openPdf(blob: Blob): Promise<Doc> {
  const base = `${import.meta.env.BASE_URL}pdfjs/`;
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    wasmUrl: `${base}wasm/`,
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    iccUrl: `${base}iccs/`,
  }).promise;
  return {
    pages: pdf.numPages,
    async size(p) {
      const vp = (await pdf.getPage(p + 1)).getViewport({ scale: 1 });
      return { w: vp.width, h: vp.height };
    },
    async draw(p, canvas, scale, rot) {
      const page = await pdf.getPage(p + 1);
      const vp = page.getViewport({ scale, rotation: (page.rotate + rot) % 360 });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    },
  };
}

async function openImage(blob: Blob): Promise<Doc> {
  const img = await createImageBitmap(blob);
  return {
    pages: 1,
    async size() {
      return { w: img.width, h: img.height };
    },
    async draw(_p, canvas, scale, rot) {
      const w = img.width * scale;
      const h = img.height * scale;
      const turned = rot % 180 !== 0;
      canvas.width = Math.floor(turned ? h : w);
      canvas.height = Math.floor(turned ? w : h);
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    },
  };
}

export function openDoc(name: string, blob: Blob): Promise<Doc> {
  let d = cache.get(name);
  if (!d) {
    d = blob.type === 'application/pdf' || name.endsWith('.pdf') ? openPdf(blob) : openImage(blob);
    d.catch(() => cache.delete(name));
    cache.set(name, d);
  }
  return d;
}

// A song's pages across all its files, in order.
export interface PageRef {
  song: Song;
  file: string; // blob name
  page: number; // page within the file
  index: number; // page within the song (annotation key)
}

export async function songPages(song: Song, load: (name: string) => Promise<Blob | undefined>): Promise<PageRef[]> {
  const out: PageRef[] = [];
  for (const f of song.files) {
    if (f.role === 'source') continue;
    const name = blobName(f);
    const blob = await load(name);
    if (!blob) continue;
    const doc = await openDoc(name, blob);
    for (let p = 0; p < doc.pages; p++) out.push({ song, file: name, page: p, index: out.length });
  }
  return out;
}

const MAX_SIDE = 8192;

// Render one page, rotated and cropped as set up, as large as fits in
// maxW × maxH. Returns the frame describing how it was drawn.
export async function renderPage(
  ref: PageRef,
  canvas: HTMLCanvasElement,
  maxW: number,
  maxH: number,
  load: (name: string) => Promise<Blob | undefined>,
  setup?: PageSetup,
): Promise<Frame | undefined> {
  const blob = await load(ref.file);
  if (!blob) return;
  const doc = await openDoc(ref.file, blob);
  // Sizes already include a PDF page's own rotation, like draw() at rot 0.
  const { w, h } = await doc.size(ref.page);
  const unit = new Frame(setup, w, h);
  let scale = Math.min(maxW / unit.width, maxH / unit.height);
  // Keep the full rotated page within canvas limits when zoomed on a small crop.
  scale = Math.min(scale, MAX_SIDE / Math.max(unit.rw, unit.rh));
  const full = document.createElement('canvas');
  await doc.draw(ref.page, full, scale, unit.rot);
  const frame = new Frame(setup, w * scale, h * scale);
  canvas.width = Math.max(1, Math.round(frame.width));
  canvas.height = Math.max(1, Math.round(frame.height));
  const [l, t] = frame.crop;
  canvas.getContext('2d')!.drawImage(full, -l * full.width, -t * full.height);
  return frame;
}
