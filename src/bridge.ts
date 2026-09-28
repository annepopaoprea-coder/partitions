// Talks to the Partitions ↔ MuseScore bridge running on the computer
// (bridge/partitions-bridge.py). Only available on the PC where it runs.

import { useEffect, useState } from 'preact/hooks';
import { blobName, type FileRef, type Song } from './model';
import { addFile, loadBlob, store } from './services';

const BASE = 'http://127.0.0.1:47823';

export interface BridgeStatus {
  musescore: string | null;
  audiveris: boolean;
}

let last: BridgeStatus | null = null;

export async function bridgeStatus(): Promise<BridgeStatus | null> {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500) });
    last = r.ok ? await r.json() : null;
  } catch {
    last = null;
  }
  return last;
}

export function useBridge(): BridgeStatus | null {
  const [s, set] = useState(last);
  useEffect(() => {
    void bridgeStatus().then(set);
    const t = setInterval(() => void bridgeStatus().then(set), 30_000);
    return () => clearInterval(t);
  }, []);
  return s;
}

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `Erreur ${r.status}`);
  return data;
}

export const sourceOf = (song: Song) => song.files.find((f) => f.role === 'source');
export const displayedOf = (song: Song) => song.files.find((f) => f.role !== 'source');

async function payload(f: FileRef) {
  const blob = await loadBlob(blobName(f));
  if (!blob) throw new Error('Fichier pas encore téléchargé sur cet appareil.');
  return { name: f.name, data: toB64(await blob.arrayBuffer()) };
}

export interface JobFile {
  name: string;
  role: 'source' | null;
  label: string;
  data: string;
}

// Run a MuseScore / Audiveris job on a song file and wait for the result.
export async function runJob<T = JobFile[]>(op: string, song: Song, file: FileRef, params: Record<string, unknown> = {}): Promise<T> {
  const { id } = await post('/jobs', { op, title: song.title, ...(await payload(file)), params });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await fetch(`${BASE}/jobs/${id}`);
    const job = await r.json();
    if (job.status === 'done') return job.result as T;
    if (job.status === 'error' || !r.ok) throw new Error(job.message ?? job.error ?? 'La tâche a échoué.');
  }
}

function fileOf(j: { name: string; data: string }, type: string) {
  return new File([fromB64(j.data)], j.name, { type });
}

// New songs from a job's files (PDF shown + MuseScore source), in the same
// groups as the original so they appear next to it.
export async function addResults(original: Song, files: JobFile[]): Promise<Song[]> {
  const byLabel = new Map<string, { pdf?: JobFile; src?: JobFile }>();
  for (const f of files) {
    const key = f.name.replace(/\.[^.]+$/, '');
    const e = byLabel.get(key) ?? {};
    if (f.role === 'source') e.src = f;
    else e.pdf = f;
    byLabel.set(key, e);
  }
  const songs: Song[] = [];
  for (const [title, { pdf, src }] of byLabel) {
    const refs: FileRef[] = [];
    if (pdf) refs.push(await addFile(fileOf(pdf, 'application/pdf')));
    if (src) refs.push({ ...(await addFile(fileOf(src, 'application/x-musescore'))), role: 'source' });
    songs.push({
      id: crypto.randomUUID(),
      kind: 'song',
      title,
      files: refs,
      groups: original.groups,
      createdAt: Date.now(),
      updatedAt: 0,
      deviceId: '',
    });
  }
  await store.put(songs);
  return songs;
}

export async function openInMuseScore(song: Song) {
  const src = sourceOf(song);
  if (!src) throw new Error('Ce morceau n’a pas encore de partition MuseScore.');
  await post('/edit', { songId: song.id, title: song.title, ...(await payload(src)) });
}

interface Edit {
  songId: string;
  version: number;
  pdf?: string;
  mscz?: string;
  msczName?: string;
  error?: string;
}

// Bring back what was saved in MuseScore: the song's PDF and source are replaced.
export async function collectEdits(): Promise<string[]> {
  let list: Edit[];
  try {
    const r = await fetch(`${BASE}/edits`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    list = await r.json();
  } catch {
    return [];
  }
  const updated: string[] = [];
  for (const e of list) {
    const song = store.get<Song>(e.songId);
    if (song && e.pdf && e.mscz) {
      const title = song.title;
      const pdf = await addFile(new File([fromB64(e.pdf)], `${title}.pdf`, { type: 'application/pdf' }));
      const src = { ...(await addFile(new File([fromB64(e.mscz)], e.msczName ?? `${title}.mscz`, { type: 'application/x-musescore' }))), role: 'source' as const };
      // Page settings and annotations belonged to the old engraving.
      await store.put({ ...song, files: [pdf, src], pages: undefined, links: undefined });
      updated.push(title);
    }
    await post(`/edits/${e.songId}/ack`, { version: e.version });
  }
  return updated;
}

// Songs imported as a MuseScore / MusicXML file: add the engraved PDF.
export async function engraveSources(songs: Song[]) {
  if (!(await bridgeStatus())?.musescore) return;
  for (const s of songs) {
    const src = sourceOf(s);
    if (!src || displayedOf(s)) continue;
    try {
      const out = await runJob('render', s, src);
      const pdf = out.find((f) => f.role !== 'source');
      if (!pdf) continue;
      const ref = await addFile(fileOf(pdf, 'application/pdf'));
      const cur = store.get<Song>(s.id) ?? s;
      await store.put({ ...cur, files: [ref, ...cur.files] });
    } catch (e) {
      console.warn('render', e);
    }
  }
}
