// Local database: every record and cached file lives in IndexedDB so the app
// works offline. The in-memory map is the source for the UI.
//
// When the app lock is on, everything stored here is encrypted (AES-GCM) with
// a random per-device data key. That key is itself stored encrypted with a
// key derived from the lock password, so nothing is readable before unlock.

import { openDB, type IDBPDatabase } from 'idb';
import { LOCK_ID, newer, type LockRec, type Rec } from './model';
import type { LockConfig } from './lock';

type Listener = () => void;

interface Sealed {
  id: string;
  box: ArrayBuffer; // iv (12 bytes) + AES-GCM ciphertext of the record JSON
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function seal(key: CryptoKey, data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out.buffer;
}

async function open(key: CryptoKey, box: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(box, 0, 12) }, key, new Uint8Array(box, 12));
}

export class Store {
  recs = new Map<string, Rec>();
  deviceId = '';
  // Encrypted data waiting for the password: records are not loaded yet.
  sealed = false;
  private dek?: CryptoKey; // data key, only in memory while unlocked
  private db!: IDBPDatabase;
  private listeners = new Set<Listener>();
  private changeListeners = new Set<(ids: string[]) => void>();
  lockMirror: LockConfig | null = null;

  async open(name = 'partitions') {
    this.db = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('recs', { keyPath: 'id' });
        db.createObjectStore('blobs');
        db.createObjectStore('meta');
      },
    });
    let id = await this.getMeta<string>('deviceId');
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      await this.setMeta('deviceId', id);
    }
    this.deviceId = id;
    this.lockMirror = (await this.getMeta<LockConfig | null>('lockConfig')) ?? null;
    if (await this.getMeta('dataKey')) {
      this.sealed = true;
      return;
    }
    for (const r of (await this.db.getAll('recs')) as Rec[]) this.recs.set(r.id, r);
  }

  get encrypted() {
    return !!this.dek;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Fired only for edits made on this device (to schedule an upload).
  onLocalChange(fn: (ids: string[]) => void) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  get<T extends Rec>(id: string): T | undefined {
    const r = this.recs.get(id);
    return r && !r.deleted ? (r as T) : undefined;
  }

  all<K extends Rec['kind']>(kind: K): Extract<Rec, { kind: K }>[] {
    const out: Extract<Rec, { kind: K }>[] = [];
    for (const r of this.recs.values()) if (r.kind === kind && !r.deleted) out.push(r as Extract<Rec, { kind: K }>);
    return out;
  }

  // Records as written to IndexedDB (sealed when encryption is on).
  private async stored(list: Rec[]): Promise<(Rec | Sealed)[]> {
    if (!this.dek) return list;
    return Promise.all(list.map(async (r) => ({ id: r.id, box: await seal(this.dek!, enc.encode(JSON.stringify(r))) })));
  }

  private async write(list: Rec[]) {
    if (this.sealed) throw new Error('Bibliothèque verrouillée');
    const rows = await this.stored(list);
    const tx = this.db.transaction('recs', 'readwrite');
    for (const row of rows) tx.store.put(row);
    await tx.done;
    for (const r of list) if (r.id === LOCK_ID) await this.mirrorLock(r as LockRec);
  }

  // Keep the lock settings readable before unlock (they hold no secret in clear).
  private async mirrorLock(r: LockRec) {
    this.lockMirror = r.deleted ? null : r.config;
    await this.setMeta('lockConfig', this.lockMirror);
  }

  // Save a local edit. The timestamp always moves forward, even if this
  // device's clock is behind the one that wrote the previous version.
  async put(recs: Rec | Rec[]) {
    const list = (Array.isArray(recs) ? recs : [recs]).map((r) => {
      const prev = this.recs.get(r.id);
      return { ...r, deviceId: this.deviceId, updatedAt: Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1) } as Rec;
    });
    await this.write(list);
    for (const r of list) this.recs.set(r.id, r);
    this.emit();
    for (const fn of this.changeListeners) fn(list.map((r) => r.id));
  }

  // Deleting moves to the trash; `restore` brings it back on every device.
  async remove(rec: Rec) {
    await this.put({ ...rec, deleted: true, deletedAt: Date.now() });
  }

  async restore(rec: Rec) {
    const { deletedAt: _, ...rest } = rec;
    await this.put({ ...rest, deleted: false } as Rec);
  }

  // Deleted songs, setlists and groups from the last `days` days, newest first.
  trash(days = 30): Rec[] {
    const since = Date.now() - days * 86_400_000;
    return [...this.recs.values()]
      .filter((r) => r.deleted && r.kind !== 'ann' && r.kind !== 'lock' && (r.deletedAt ?? 0) >= since)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }

  // Merge records from another device; returns how many changed.
  async merge(remote: Rec[]): Promise<number> {
    const changed = remote.filter((r) => newer(r, this.recs.get(r.id)));
    if (!changed.length) return 0;
    await this.write(changed);
    for (const r of changed) this.recs.set(r.id, r);
    this.emit();
    return changed.length;
  }

  // Everything this device authored that is still the current version.
  ownRecords(): Rec[] {
    return [...this.recs.values()].filter((r) => r.deviceId === this.deviceId);
  }

  async getBlob(name: string): Promise<Blob | undefined> {
    const v = await this.db.get('blobs', name);
    if (!v) return undefined;
    if (v instanceof Blob) return v;
    // Sealed file: { type, box }.
    if (!this.dek) return undefined;
    return new Blob([await open(this.dek, v.box)], { type: v.type });
  }

  async putBlob(name: string, blob: Blob) {
    const value = this.dek ? { type: blob.type, box: await seal(this.dek, await blob.arrayBuffer()) } : blob;
    await this.db.put('blobs', value, name);
  }

  async hasBlob(name: string): Promise<boolean> {
    return (await this.db.getKey('blobs', name)) !== undefined;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return this.db.get('meta', key);
  }

  async setMeta(key: string, value: unknown) {
    await this.db.put('meta', value, key);
  }

  // ---- Encryption -------------------------------------------------------

  // Open the sealed library with the key derived from the lock password.
  // Returns false when that key does not fit (password changed elsewhere).
  async unseal(kek: CryptoKey): Promise<boolean> {
    const wrapped = await this.getMeta<ArrayBuffer>('dataKey');
    if (!wrapped) return true;
    let raw: ArrayBuffer;
    try {
      raw = await open(kek, wrapped);
    } catch {
      return false;
    }
    return this.unsealRaw(raw);
  }

  // Open the sealed library with the data key itself (fingerprint unlock).
  async unsealRaw(raw: ArrayBuffer): Promise<boolean> {
    const dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const recs = new Map<string, Rec>();
    try {
      for (const row of (await this.db.getAll('recs')) as (Rec | Sealed)[]) {
        const r = 'box' in row ? (JSON.parse(dec.decode(await open(dek, row.box))) as Rec) : row;
        recs.set(r.id, r);
      }
    } catch {
      return false; // not this library's key
    }
    this.rawDek = raw;
    this.dek = dek;
    this.recs = recs;
    this.sealed = false;
    this.emit();
    return true;
  }

  // Turn encryption on for this device and rewrite everything sealed.
  async encrypt(kek: CryptoKey, onProgress?: (done: number, total: number) => void) {
    if (this.dek) return this.rewrap(kek);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await this.transform(async (v) => ({ type: v.type, box: await seal(dek, await v.arrayBuffer()) }), onProgress, dek);
    await this.setMeta('dataKey', await seal(kek, raw));
    this.dek = dek;
    this.rawDek = raw.buffer;
  }

  // Keep the same data key, now opened by a new password.
  async rewrap(kek: CryptoKey) {
    if (this.rawDek) await this.setMeta('dataKey', await seal(kek, this.rawDek));
  }

  // The data key in clear, kept in memory only while unlocked.
  private rawDek?: ArrayBuffer;

  dataKey(): ArrayBuffer | undefined {
    return this.rawDek;
  }

  // Turn encryption off: rewrite everything in clear.
  async decrypt(onProgress?: (done: number, total: number) => void) {
    if (!this.dek) return;
    const dek = this.dek;
    await this.transform(async (v, sealed) => (sealed ? new Blob([await open(dek, sealed.box)], { type: sealed.type }) : v), onProgress, undefined);
    this.dek = undefined;
    this.rawDek = undefined;
    await this.db.delete('meta', 'dataKey');
    await this.db.delete('meta', 'bioKey');
  }

  // Rewrite every record and file with `dek` (or in clear when undefined).
  private async transform(
    blobFn: (v: Blob, sealed?: { type: string; box: ArrayBuffer }) => Promise<Blob | { type: string; box: ArrayBuffer }>,
    onProgress: ((done: number, total: number) => void) | undefined,
    dek: CryptoKey | undefined,
  ) {
    const names = (await this.db.getAllKeys('blobs')) as string[];
    const total = names.length + 1;
    const previous = this.dek;
    this.dek = dek;
    const rows = await this.stored([...this.recs.values()]);
    const tx = this.db.transaction('recs', 'readwrite');
    await tx.store.clear();
    for (const row of rows) tx.store.put(row);
    await tx.done;
    this.dek = previous;
    onProgress?.(1, total);
    let done = 1;
    for (const name of names) {
      const v = await this.db.get('blobs', name);
      const next = v instanceof Blob ? await blobFn(v) : await blobFn(new Blob([]), v);
      await this.db.put('blobs', next, name);
      onProgress?.(++done, total);
    }
  }

  // Forget everything on this device (it will download the library again from
  // Drive). A new device id makes this device read back its own old journal.
  async wipe() {
    const keep = ['sharded'];
    const tx = this.db.transaction(['recs', 'blobs', 'meta'], 'readwrite');
    await tx.objectStore('recs').clear();
    await tx.objectStore('blobs').clear();
    for (const k of (await tx.objectStore('meta').getAllKeys()) as string[]) {
      if (!keep.includes(k)) await tx.objectStore('meta').delete(k);
    }
    await tx.done;
    this.recs.clear();
    this.dek = undefined;
    this.rawDek = undefined;
    this.sealed = false;
    this.lockMirror = null;
    this.deviceId = crypto.randomUUID().slice(0, 8);
    await this.setMeta('deviceId', this.deviceId);
    this.emit();
  }
}

export const store = new Store();
