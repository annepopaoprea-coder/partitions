// Local database: every record and cached file lives in IndexedDB so the app
// works offline. The in-memory map is the source for the UI.

import { openDB, type IDBPDatabase } from 'idb';
import { newer, type Rec } from './model';

type Listener = () => void;

export class Store {
  recs = new Map<string, Rec>();
  deviceId = '';
  private db!: IDBPDatabase;
  private listeners = new Set<Listener>();
  private changeListeners = new Set<(ids: string[]) => void>();

  async open(name = 'partitions') {
    this.db = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('recs', { keyPath: 'id' });
        db.createObjectStore('blobs');
        db.createObjectStore('meta');
      },
    });
    for (const r of (await this.db.getAll('recs')) as Rec[]) this.recs.set(r.id, r);
    let id = await this.getMeta<string>('deviceId');
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      await this.setMeta('deviceId', id);
    }
    this.deviceId = id;
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

  // Save a local edit. The timestamp always moves forward, even if this
  // device's clock is behind the one that wrote the previous version.
  async put(recs: Rec | Rec[]) {
    const list = Array.isArray(recs) ? recs : [recs];
    const tx = this.db.transaction('recs', 'readwrite');
    for (const r of list) {
      const prev = this.recs.get(r.id);
      const saved = {
        ...r,
        deviceId: this.deviceId,
        updatedAt: Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1),
      } as Rec;
      this.recs.set(saved.id, saved);
      tx.store.put(saved);
    }
    await tx.done;
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
    const changed: Rec[] = [];
    for (const r of remote) {
      if (newer(r, this.recs.get(r.id))) changed.push(r);
    }
    if (!changed.length) return 0;
    const tx = this.db.transaction('recs', 'readwrite');
    for (const r of changed) {
      this.recs.set(r.id, r);
      tx.store.put(r);
    }
    await tx.done;
    this.emit();
    return changed.length;
  }

  // Everything this device authored that is still the current version.
  ownRecords(): Rec[] {
    return [...this.recs.values()].filter((r) => r.deviceId === this.deviceId);
  }

  async getBlob(name: string): Promise<Blob | undefined> {
    return this.db.get('blobs', name);
  }

  async putBlob(name: string, blob: Blob) {
    await this.db.put('blobs', blob, name);
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
}

export const store = new Store();
