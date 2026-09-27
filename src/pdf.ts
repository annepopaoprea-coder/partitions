// Page rendering for PDF and image files.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { blobName, type Song } from './model';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Doc {
  pages: number;
  size(page: number): Promise<{ w: number; h: number }>;
  render(page: number, canvas: HTMLCanvasElement, width: number, height: number): Promise<void>;
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
    async render(p, canvas, width, height) {
      const page = await pdf.getPage(p + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(width / vp1.width, height / vp1.height);
      const vp = page.getViewport({ scale });
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
    async render(_p, canvas, width, height) {
      const scale = Math.min(width / img.width, height / img.height);
      canvas.width = Math.floor(img.width * scale);
      canvas.height = Math.floor(img.height * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
    const name = blobName(f);
    const blob = await load(name);
    if (!blob) continue;
    const doc = await openDoc(name, blob);
    for (let p = 0; p < doc.pages; p++) out.push({ song, file: name, page: p, index: out.length });
  }
  return out;
}

export async function renderPage(
  ref: PageRef,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  load: (name: string) => Promise<Blob | undefined>,
) {
  const blob = await load(ref.file);
  if (!blob) return;
  await (await openDoc(ref.file, blob)).render(ref.page, canvas, width, height);
}
