// Automatic synchronisation through a shared cloud folder.
//
// Each device only ever writes its own journal files, holding the latest
// version of every record it authored. Devices read each other's journals and
// keep the newest version of each record, so two devices never overwrite the
// same cloud file and no edit is lost to a race.
// A device's journal is split into SHARDS compressed files
// (journal/<deviceId>.<shard>.json.gz) so an edit only re-uploads one small
// file. Song files are uploaded once under a unique name and cached on every
// device.

import { blobName, type Rec } from './model';
import type { Store } from './store';

export interface Journal {
  deviceId: string;
  deviceName: string;
  updatedAt: number;
  records: Rec[];
}

export interface RemoteEntry {
  id: string;
  name: string;
  modified: string;
}

export interface Remote {
  ready(): Promise<boolean>; // false when signed out
  listJournals(): Promise<RemoteEntry[]>;
  readJournal(entry: RemoteEntry): Promise<Journal>;
  writeJournal(name: string, journal: Journal): Promise<void>;
  deleteJournal(name: string): Promise<void>;
  listBlobs(): Promise<Set<string>>;
  uploadBlob(name: string, blob: Blob): Promise<void>;
  downloadBlob(name: string): Promise<Blob>;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'signed-out' | 'error';

export interface SyncStatus {
  state: SyncState;
  lastSync?: number;
  message?: string;
  pendingFiles: number;
  missingFiles: number;
}

export const SHARDS = 64;

// Stable shard for a record id (FNV-1a hash).
export function shardOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SHARDS;
}

export const journalName = (deviceId: string, shard: number) => `${deviceId}.${shard}.json.gz`;

// With the app open in several tabs, only one syncs at a time; the others
// skip their turn instead of uploading the same files twice.
function exclusive(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return fn();
  return locks.request('partitions-sync', { ifAvailable: true }, (lock) => (lock ? fn() : undefined));
}

export class Sync {
  status: SyncStatus = { state: 'idle', pendingFiles: 0, missingFiles: 0 };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private shardSeq = new Map<number, number>(); // edits per shard, to spot edits made mid-upload
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private store: Store,
    private remote: Remote,
    private deviceName: () => string = () => 'Appareil',
  ) {
    store.onLocalChange((ids) => void this.markDirty(ids));
  }

  private async markDirty(ids: string[]) {
    const dirty = new Set((await this.store.getMeta<number[]>('dirtyShards')) ?? []);
    for (const id of ids) {
      const sh = shardOf(id);
      dirty.add(sh);
      this.shardSeq.set(sh, (this.shardSeq.get(sh) ?? 0) + 1);
    }
    await this.store.setMeta('dirtyShards', [...dirty]);
    this.soon(3000);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }

  // Debounced sync, used after local edits.
  soon(ms = 3000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  // Keep syncing: now, periodically, and when the app comes back to screen
  // or the network returns.
  start(intervalMs = 60_000) {
    void this.run();
    setInterval(() => void this.run(), intervalMs);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.run();
      });
      window.addEventListener('online', () => void this.run());
    }
  }

  async queueBlob(name: string) {
    const pending = new Set((await this.store.getMeta<string[]>('pendingBlobs')) ?? []);
    pending.add(name);
    await this.store.setMeta('pendingBlobs', [...pending]);
    this.set({ pendingFiles: pending.size });
  }

  // Runs one full sync; concurrent calls coalesce into one extra pass.
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = exclusive(async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    }).finally(() => (this.running = null));
    return this.running;
  }

  private async pass() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.set({ state: 'offline' });
      return;
    }
    try {
      if (!(await this.remote.ready())) {
        this.set({ state: 'signed-out' });
        return;
      }
      this.set({ state: 'syncing', message: undefined });
      // Records first: edits and settings reach other devices right away,
      // even while a large batch of files is still uploading.
      await this.pull();
      await this.push();
      await this.uploadPending();
      this.set({ state: 'idle', lastSync: Date.now() });
      void this.prefetch();
    } catch (e) {
      console.error('sync', e);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      this.set({ state: offline ? 'offline' : 'error', message: String((e as Error)?.message ?? e) });
    }
  }

  private async uploadPending() {
    const pending = (await this.store.getMeta<string[]>('pendingBlobs')) ?? [];
    if (!pending.length) return;
    const remoteBlobs = await this.remote.listBlobs();
    const left = new Set(pending);
    for (const name of pending) {
      if (!remoteBlobs.has(name)) {
        const blob = await this.store.getBlob(name);
        if (blob) await this.remote.uploadBlob(name, blob);
      }
      left.delete(name);
      await this.store.setMeta('pendingBlobs', [...left]);
      this.set({ pendingFiles: left.size });
    }
  }

  private async pull() {
    const seen = (await this.store.getMeta<Record<string, string>>('seenJournals')) ?? {};
    const me = this.store.deviceId;
    for (const entry of await this.remote.listJournals()) {
      if (entry.name.startsWith(`${me}.`) || seen[entry.name] === entry.modified) continue;
      const journal = await this.remote.readJournal(entry);
      await this.store.merge(journal.records ?? []);
      seen[entry.name] = entry.modified;
      await this.store.setMeta('seenJournals', seen);
    }
  }

  private async push() {
    const me = this.store.deviceId;
    const dirty = new Set((await this.store.getMeta<number[]>('dirtyShards')) ?? []);
    // Devices from before sharding kept one big journal: rewrite it as shards.
    const legacy = await this.store.getMeta<boolean>('dirty');
    const upgrading = (await this.store.getMeta<boolean>('sharded')) !== true;
    if (upgrading) for (const r of this.store.ownRecords()) dirty.add(shardOf(r.id));
    if (!dirty.size) {
      if (upgrading) await this.store.setMeta('sharded', true);
      return;
    }
    const own = this.store.ownRecords();
    for (const sh of [...dirty].sort((a, b) => a - b)) {
      const seq = this.shardSeq.get(sh) ?? 0;
      await this.remote.writeJournal(journalName(me, sh), {
        deviceId: me,
        deviceName: this.deviceName(),
        updatedAt: Date.now(),
        records: own.filter((r) => shardOf(r.id) === sh),
      });
      // An edit to this shard during the upload keeps it dirty for next time.
      if ((this.shardSeq.get(sh) ?? 0) === seq) {
        const now = new Set((await this.store.getMeta<number[]>('dirtyShards')) ?? []);
        now.delete(sh);
        await this.store.setMeta('dirtyShards', [...now]);
      } else this.again = true;
    }
    if (upgrading) {
      await this.remote.deleteJournal(`${me}.json`);
      await this.store.setMeta('sharded', true);
      if (legacy) await this.store.setMeta('dirty', false);
    }
  }

  private prefetching: Promise<void> | null = null;

  // Download every song file not yet on this device, so the whole library is
  // readable offline.
  prefetch(): Promise<void> {
    this.prefetching ??= this.download().finally(() => (this.prefetching = null));
    return this.prefetching;
  }

  private async download() {
    {
      const missing: string[] = [];
      for (const s of this.store.all('song'))
        for (const f of s.files) {
          const n = blobName(f);
          if (!(await this.store.hasBlob(n))) missing.push(n);
        }
      this.set({ missingFiles: missing.length });
      for (const name of missing) {
        try {
          await this.store.putBlob(name, await this.remote.downloadBlob(name));
        } catch (e) {
          console.warn('prefetch', name, e);
        }
        this.set({ missingFiles: this.status.missingFiles - 1 });
      }
    }
  }

  // Fetch one file right away (opening a song not yet cached).
  async fetchBlob(name: string): Promise<Blob | undefined> {
    const local = await this.store.getBlob(name);
    if (local) return local;
    if (!(await this.remote.ready())) return undefined;
    const blob = await this.remote.downloadBlob(name);
    await this.store.putBlob(name, blob);
    return blob;
  }
}
