import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import type { Song } from '../src/model';

let n = 0;
const kek = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const song = (id: string, title: string): Song => ({ id, kind: 'song', title, files: [], groups: {}, createdAt: 0, updatedAt: 0, deviceId: '' });

async function rawDump(name: string) {
  const db = await openDB(name);
  const recs = await db.getAll('recs');
  const blobs = await db.getAll('blobs');
  db.close();
  const blobText = await Promise.all(blobs.map(async (b) => (b instanceof Blob ? b.text() : new TextDecoder().decode(b.box))));
  return JSON.stringify(recs) + blobText.join('');
}

describe('local encryption', () => {
  it('seals records and files; nothing readable before unlock', async () => {
    const name = `enc-${n++}`;
    const key = await kek();
    const s = new Store();
    await s.open(name);
    await s.put(song('s1', 'Musette pour Mathilde'));
    await s.putBlob('f1.pdf', new Blob(['%PDF contenu secret'], { type: 'application/pdf' }));
    await s.encrypt(key);
    expect(await rawDump(name)).not.toContain('Mathilde');
    expect(await rawDump(name)).not.toContain('contenu secret');

    // Reopening (a new app start): sealed until the password is given.
    const again = new Store();
    await again.open(name);
    expect(again.sealed).toBe(true);
    expect(again.recs.size).toBe(0);
    expect(await again.getBlob('f1.pdf')).toBeUndefined();
    await expect(again.put(song('s2', 'x'))).rejects.toThrow();

    expect(await again.unseal(key)).toBe(true);
    expect(again.get<Song>('s1')?.title).toBe('Musette pour Mathilde');
    expect(await (await again.getBlob('f1.pdf'))!.text()).toBe('%PDF contenu secret');

    // New edits stay sealed.
    await again.put(song('s3', 'Gavotte pour Isla'));
    expect(await rawDump(name)).not.toContain('Isla');
  });

  it('refuses a wrong key', async () => {
    const name = `enc-${n++}`;
    const s = new Store();
    await s.open(name);
    await s.put(song('s1', 'Menuet'));
    await s.encrypt(await kek());
    const again = new Store();
    await again.open(name);
    expect(await again.unseal(await kek())).toBe(false);
    expect(again.sealed).toBe(true);
  });

  it('opens with the new password after a change, and can be turned off', async () => {
    const name = `enc-${n++}`;
    const oldKey = await kek();
    const newKey = await kek();
    const s = new Store();
    await s.open(name);
    await s.put(song('s1', 'Bourrée'));
    await s.putBlob('f.pdf', new Blob(['page']));
    await s.encrypt(oldKey);
    await s.rewrap(newKey);
    const again = new Store();
    await again.open(name);
    expect(await again.unseal(oldKey)).toBe(false);
    expect(await again.unseal(newKey)).toBe(true);
    await again.decrypt();
    expect(await rawDump(name)).toContain('Bourrée');
    const clear = new Store();
    await clear.open(name);
    expect(clear.sealed).toBe(false);
    expect(clear.get<Song>('s1')?.title).toBe('Bourrée');
    expect(await (await clear.getBlob('f.pdf'))!.text()).toBe('page');
  });

  it('wipes the device and takes a new identity', async () => {
    const name = `enc-${n++}`;
    const s = new Store();
    await s.open(name);
    const before = s.deviceId;
    await s.put(song('s1', 'Sarabande'));
    await s.wipe();
    expect(s.recs.size).toBe(0);
    expect(s.deviceId).not.toBe(before);
  });
});
