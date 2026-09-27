import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { Sync, type Journal, type Remote, type RemoteEntry } from '../src/sync';
import type { Song } from '../src/model';

// A shared in-memory "Drive" standing in for Google Drive.
class MemoryCloud {
  journals = new Map<string, { data: string; modified: string }>();
  blobs = new Map<string, Blob>();
  tick = 0;
}

class MemoryRemote implements Remote {
  constructor(private cloud: MemoryCloud) {}
  async ready() {
    return true;
  }
  async listJournals(): Promise<RemoteEntry[]> {
    return [...this.cloud.journals].map(([name, j]) => ({ id: name, name, modified: j.modified }));
  }
  async readJournal(e: RemoteEntry): Promise<Journal> {
    return JSON.parse(this.cloud.journals.get(e.name)!.data);
  }
  async writeJournal(j: Journal) {
    this.cloud.journals.set(`${j.deviceId}.json`, { data: JSON.stringify(j), modified: String(++this.cloud.tick) });
  }
  async listBlobs() {
    return new Set(this.cloud.blobs.keys());
  }
  async uploadBlob(name: string, blob: Blob) {
    this.cloud.blobs.set(name, blob);
  }
  async downloadBlob(name: string) {
    return this.cloud.blobs.get(name)!;
  }
}

let n = 0;
async function device(cloud: MemoryCloud) {
  const store = new Store();
  await store.open(`test-${n++}`);
  const sync = new Sync(store, new MemoryRemote(cloud));
  return { store, sync };
}

function song(id: string, title: string): Song {
  return { id, kind: 'song', title, files: [], groups: {}, createdAt: 0, updatedAt: 0, deviceId: '' };
}

describe('sync', () => {
  it('propagates a new song to other devices', async () => {
    const cloud = new MemoryCloud();
    const tablet = await device(cloud);
    const phone = await device(cloud);
    await tablet.store.put(song('s1', 'Bach Musette'));
    await tablet.sync.run();
    await phone.sync.run();
    expect(phone.store.get<Song>('s1')?.title).toBe('Bach Musette');
  });

  it('keeps edits from both devices on different songs', async () => {
    const cloud = new MemoryCloud();
    const a = await device(cloud);
    const b = await device(cloud);
    await a.store.put([song('s1', 'Un'), song('s2', 'Deux')]);
    await a.sync.run();
    await b.sync.run();
    await a.store.put({ ...a.store.get<Song>('s1')!, title: 'Un (tablette)' });
    await b.store.put({ ...b.store.get<Song>('s2')!, title: 'Deux (téléphone)' });
    await a.sync.run();
    await b.sync.run();
    await a.sync.run();
    for (const d of [a, b]) {
      expect(d.store.get<Song>('s1')?.title).toBe('Un (tablette)');
      expect(d.store.get<Song>('s2')?.title).toBe('Deux (téléphone)');
    }
  });

  it('newest edit of the same song wins everywhere', async () => {
    const cloud = new MemoryCloud();
    const a = await device(cloud);
    const b = await device(cloud);
    await a.store.put(song('s1', 'Original'));
    await a.sync.run();
    await b.sync.run();
    await a.store.put({ ...a.store.get<Song>('s1')!, title: 'Ancien' });
    await new Promise((r) => setTimeout(r, 5));
    await b.store.put({ ...b.store.get<Song>('s1')!, title: 'Récent' });
    await a.sync.run();
    await b.sync.run();
    await a.sync.run();
    expect(a.store.get<Song>('s1')?.title).toBe('Récent');
    expect(b.store.get<Song>('s1')?.title).toBe('Récent');
  });

  it('propagates deletions', async () => {
    const cloud = new MemoryCloud();
    const a = await device(cloud);
    const b = await device(cloud);
    await a.store.put(song('s1', 'À supprimer'));
    await a.sync.run();
    await b.sync.run();
    await b.store.remove(b.store.get<Song>('s1')!);
    await b.sync.run();
    await a.sync.run();
    expect(a.store.get('s1')).toBeUndefined();
  });

  it('uploads files and caches them on other devices', async () => {
    const cloud = new MemoryCloud();
    const a = await device(cloud);
    const b = await device(cloud);
    const file = { id: 'f1', name: 'x.pdf', mime: 'application/pdf', size: 3 };
    await a.store.putBlob('f1.pdf', new Blob(['pdf']));
    await a.sync.queueBlob('f1.pdf');
    await a.store.put({ ...song('s1', 'Avec fichier'), files: [file] });
    await a.sync.run();
    expect(cloud.blobs.has('f1.pdf')).toBe(true);
    await b.sync.run();
    await b.sync.prefetch();
    expect(await b.store.hasBlob('f1.pdf')).toBe(true);
  });

  it('does not re-upload when nothing changed', async () => {
    const cloud = new MemoryCloud();
    const a = await device(cloud);
    await a.store.put(song('s1', 'X'));
    await a.sync.run();
    const tick = cloud.tick;
    await a.sync.run();
    expect(cloud.tick).toBe(tick);
  });
});
