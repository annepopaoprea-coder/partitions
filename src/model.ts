// Data model shared by every device. Everything that syncs is a Rec; each
// record is replaced as a whole by the newest version (last writer wins).

export type GroupType = 'collection' | 'artist' | 'composer' | 'album' | 'genre';

export const GROUP_TYPES: GroupType[] = ['collection', 'artist', 'composer', 'album', 'genre'];

export const GROUP_LABELS: Record<GroupType, { one: string; many: string }> = {
  collection: { one: 'Collection', many: 'Collections' },
  artist: { one: 'Artiste', many: 'Artistes' },
  composer: { one: 'Compositeur', many: 'Compositeurs' },
  album: { one: 'Album', many: 'Albums' },
  genre: { one: 'Genre', many: 'Genres' },
};

interface Base {
  id: string;
  updatedAt: number;
  deviceId: string;
  deleted?: boolean;
  deletedAt?: number; // when it went to the trash
}

export interface FileRef {
  id: string; // blob name in Drive: `${id}.${ext}`
  name: string; // original file name, for display
  mime: string;
  size: number;
  // 'source': the MuseScore file behind the displayed PDF (kept, not shown).
  role?: 'source';
}

// A repeat jump placed on a page: touching it, or turning the page with the
// pedal while it has not been used yet, goes to page `to`.
export interface Link {
  id: string;
  page: number; // song page it sits on
  x: number; // position, as page fractions
  y: number;
  to: number; // destination song page
  label: string;
}

export interface Song extends Base {
  kind: 'song';
  title: string;
  files: FileRef[];
  groups: Partial<Record<GroupType, string[]>>; // group record ids
  key?: string;
  notes?: string;
  difficulty?: number;
  createdAt: number;
  pages?: Record<number, import('./frame').PageSetup>; // rotation / crop per song page
  links?: Link[];
  tempo?: number; // metronome, beats per minute
  beats?: number; // beats per bar
}

export interface Group extends Base {
  kind: 'group';
  type: GroupType;
  name: string;
}

export interface Setlist extends Base {
  kind: 'setlist';
  name: string;
  songIds: string[];
  createdAt: number;
}

// Annotation coordinates are fractions of the page size (0..1), so they
// survive any screen size or zoom.
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'stamp' | 'link';

export interface Stroke {
  t: 'stroke';
  color: string;
  width: number; // fraction of page width
  alpha: number;
  pts: number[]; // x0,y0,x1,y1,...
}

export interface TextItem {
  t: 'text';
  color: string;
  size: number; // fraction of page height
  x: number;
  y: number;
  text: string;
}

export interface StampItem {
  t: 'stamp';
  color: string;
  size: number;
  x: number;
  y: number;
  symbol: string;
}

export type AnnItem = Stroke | TextItem | StampItem;

// One record per annotated page: `ann:<songId>:<page>`.
export interface PageAnnotations extends Base {
  kind: 'ann';
  songId: string;
  page: number;
  items: AnnItem[];
}

// App lock settings, shared by all devices (see lock.ts). `config` is null
// when the lock is turned off.
export interface LockRec extends Base {
  kind: 'lock';
  config: import('./lock').LockConfig | null;
}

export const LOCK_ID = 'lock';

export type Rec = Song | Group | Setlist | PageAnnotations | LockRec;

export function annId(songId: string, page: number) {
  return `ann:${songId}:${page}`;
}

// True when `a` should replace `b`.
export function newer(a: Rec, b: Rec | undefined): boolean {
  if (!b) return true;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.deviceId > b.deviceId;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function extFor(name: string, mime: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (m) return m[1].toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return mime.slice(6);
  return 'bin';
}

export function blobName(f: FileRef): string {
  return `${f.id}.${extFor(f.name, f.mime)}`;
}
