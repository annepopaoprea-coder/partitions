// Build a PDF of several songs, pages exactly as shown in the app: rotation,
// crop and annotations. PDF pages stay vector (sharp at any zoom); only the
// annotations are added as a transparent image on top.

import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { Frame, type PageSetup } from './frame';
import { annId, blobName, extFor, type PageAnnotations, type Song } from './model';
import { store } from './services';
import { drawItems } from './ui/annotate';

const OVERLAY_SCALE = 2.5; // annotation image pixels per PDF point

export interface ExportOptions {
  title: string;
  subtitle?: string;
  songs: Song[];
  load: (name: string) => Promise<Blob | undefined>;
  onProgress?: (done: number, total: number) => void;
}

export async function exportPdf(opts: ExportOptions): Promise<Blob> {
  const out = await PDFDocument.create();
  out.setTitle(opts.title);
  out.setCreator('Partitions');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  cover(out, opts, font, bold);

  let done = 0;
  for (const song of opts.songs) {
    let index = 0; // song page index, across its files
    for (const f of song.files) {
      const name = blobName(f);
      const blob = await opts.load(name);
      if (!blob) continue;
      const ext = extFor(f.name, f.mime);
      if (ext === 'pdf') {
        const src = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true });
        for (const page of src.getPages()) {
          await addPdfPage(out, page, song, index++);
        }
      } else {
        await addImagePage(out, blob, song, index++);
      }
    }
    opts.onProgress?.(++done, opts.songs.length);
  }
  const bytes = await out.save();
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

// Position of the drawn content so a page turned clockwise by `rot` fills
// a box of size (dw, dh) starting at the origin (pdf-lib rotates
// counter-clockwise around the drawing's lower-left corner).
function placement(rot: number, w: number, h: number) {
  switch (rot) {
    case 90:
      return { x: 0, y: w, rotate: degrees(-90) };
    case 180:
      return { x: w, y: h, rotate: degrees(180) };
    case 270:
      return { x: h, y: 0, rotate: degrees(90) };
    default:
      return { x: 0, y: 0, rotate: degrees(0) };
  }
}

async function addPdfPage(out: PDFDocument, page: PDFPage, song: Song, index: number) {
  const setup: PageSetup = song.pages?.[index] ?? {};
  const { width: w, height: h } = page.getMediaBox();
  const own = ((page.getRotation().angle % 360) + 360) % 360;
  const total = (own + (setup.rot ?? 0)) % 360;
  const embedded = await out.embedPage(page);
  // What pdf.js shows at rot 0: the page with its own rotation applied.
  const shownW = own % 180 ? h : w;
  const shownH = own % 180 ? w : h;
  const frame = new Frame(setup, shownW, shownH);
  const target = out.addPage([frame.width, frame.height]);
  const full = { w: total % 180 ? h : w, h: total % 180 ? w : h };
  const p = placement(total, w, h);
  const [l, , , b] = frame.crop;
  target.drawPage(embedded, {
    x: p.x - l * full.w,
    y: p.y - (1 - b) * full.h,
    rotate: p.rotate,
  });
  await overlay(out, target, song, index, frame);
}

async function addImagePage(out: PDFDocument, blob: Blob, song: Song, index: number) {
  const setup: PageSetup = song.pages?.[index] ?? {};
  const bytes = await toPng(blob);
  const img = await out.embedPng(bytes);
  // Scale images to an A4-ish width in points.
  const scale = 595 / img.width;
  const w = img.width * scale;
  const h = img.height * scale;
  const frame = new Frame(setup, w, h);
  const target = out.addPage([frame.width, frame.height]);
  const rot = setup.rot ?? 0;
  const full = { w: rot % 180 ? h : w, h: rot % 180 ? w : h };
  const p = placement(rot, w, h);
  const [l, , , b] = frame.crop;
  target.drawImage(img, { x: p.x - l * full.w, y: p.y - (1 - b) * full.h, width: w, height: h, rotate: p.rotate });
  await overlay(out, target, song, index, frame);
}

async function overlay(out: PDFDocument, target: PDFPage, song: Song, index: number, frame: Frame) {
  const items = store.get<PageAnnotations>(annId(song.id, index))?.items;
  if (!items?.length) return;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(frame.width * OVERLAY_SCALE);
  canvas.height = Math.round(frame.height * OVERLAY_SCALE);
  drawItems(canvas.getContext('2d')!, items, new Frame({ rot: frame.rot, crop: frame.crop }, frame.pw * OVERLAY_SCALE, frame.ph * OVERLAY_SCALE));
  const png = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
  const img = await out.embedPng(await png.arrayBuffer());
  target.drawImage(img, { x: 0, y: 0, width: frame.width, height: frame.height });
}

async function toPng(blob: Blob): Promise<ArrayBuffer> {
  if (blob.type === 'image/png') return blob.arrayBuffer();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  return png.arrayBuffer();
}

// Standard PDF fonts only cover Latin-1 and a few symbols: replace the rest.
function safe(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const sub = ({ '♯': '#', '♭': 'b', '♮': '', '’': "'", '‘': "'", '–': '-', '—': '-' } as Record<string, string>)[ch];
    const c = sub ?? ch;
    try {
      font.encodeText(c);
      out += c;
    } catch {
      out += '?';
    }
  }
  return out;
}

function cover(out: PDFDocument, opts: ExportOptions, font: PDFFont, bold: PDFFont) {
  const page = out.addPage([595.28, 841.89]);
  const margin = 60;
  let y = 841.89 - 100;
  const line = (text: string, size: number, f = font, color = rgb(0.1, 0.1, 0.12)) => {
    page.drawText(safe(f, text), { x: margin, y, size, font: f, color, maxWidth: 595 - 2 * margin });
    y -= size * 1.5;
  };
  line(opts.title, 26, bold);
  if (opts.subtitle) line(opts.subtitle, 15, font, rgb(0.35, 0.35, 0.4));
  y -= 20;
  opts.songs.forEach((s, i) => {
    if (y < 70) return;
    line(`${i + 1}.  ${s.title}`, 12);
  });
  page.drawText(safe(font, `Partitions · ${new Date().toLocaleDateString('fr')}`), {
    x: margin,
    y: 40,
    size: 9,
    font,
    color: rgb(0.5, 0.5, 0.55),
  });
}

// Share the PDF (WhatsApp, e-mail… on phones and tablets) or download it.
export async function shareOrDownload(pdf: Blob, fileName: string) {
  const file = new File([pdf], fileName, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName.replace(/\.pdf$/, '') });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(pdf);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function fileNameFor(title: string) {
  return `${title.replace(/[\\/:*?"<>|]+/g, '-').trim()}.pdf`;
}
