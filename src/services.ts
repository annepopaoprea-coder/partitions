// App-wide singletons and small helpers shared by the screens.

import { useEffect, useState } from 'preact/hooks';
import { DriveRemote } from './drive';
import { blobName, uid, type FileRef, type Group, type GroupType, type Song } from './model';
import { store } from './store';
import { Sync } from './sync';

export { store };

export function clientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID || localStorage.getItem('google.clientId') || '';
}

export function deviceName(): string {
  return localStorage.getItem('deviceName') || guessDeviceName();
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Téléphone' : 'Tablette';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  return 'Ordinateur';
}

export const drive = new DriveRemote(clientId());
export const sync = new Sync(store, drive, deviceName);

export const loadBlob = (name: string) => sync.fetchBlob(name);

// Re-render when the library or sync status changes.
export function useStore() {
  const [, set] = useState(0);
  useEffect(() => store.subscribe(() => set((n) => n + 1)), []);
}

export function useSync() {
  const [s, set] = useState(sync.status);
  useEffect(() => sync.subscribe(() => set(sync.status)), []);
  return s;
}

export function useSignedIn() {
  const [s, set] = useState(drive.signedIn);
  useEffect(() => drive.onAuthChange(() => set(drive.signedIn)), []);
  return s;
}

export function mimeOf(file: File): string {
  if (file.type) return file.type;
  return file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
}

// Store a file locally and queue it for upload.
export async function addFile(file: File): Promise<FileRef> {
  const ref: FileRef = { id: uid(), name: file.name, mime: mimeOf(file), size: file.size };
  const name = blobName(ref);
  await store.putBlob(name, new Blob([file], { type: ref.mime }));
  await sync.queueBlob(name);
  return ref;
}

export async function importFiles(files: File[]): Promise<Song[]> {
  const songs: Song[] = [];
  for (const file of files) {
    const ref = await addFile(file);
    songs.push({
      id: uid(),
      kind: 'song',
      title: file.name.replace(/\.[^.]+$/, ''),
      files: [ref],
      groups: {},
      createdAt: Date.now(),
      updatedAt: 0,
      deviceId: '',
    });
  }
  await store.put(songs);
  return songs;
}

export function groupsOf(type: GroupType): Group[] {
  return store
    .all('group')
    .filter((g) => g.type === type)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export function groupNames(song: Song, type: GroupType): string[] {
  return (song.groups[type] ?? []).map((id) => store.get<Group>(id)?.name).filter(Boolean) as string[];
}

export const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

export function normalize(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
