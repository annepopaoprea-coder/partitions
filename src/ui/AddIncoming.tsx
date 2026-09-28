import { useEffect, useState } from 'preact/hooks';
import { go } from '../app';
import { clearIncoming, onIncoming } from '../inbox';
import { uid, type Group, type GroupType, type Song } from '../model';
import { groupsOf, importFiles, store, useStore } from '../services';
import { currentSchoolYear, isSchoolYear } from './ArtistTree';

// "Add to Partitions" sheet for documents opened with or shared to the app.
export function AddIncoming() {
  useStore();
  const [files, setFiles] = useState<File[]>([]);
  const [titles, setTitles] = useState<string[]>([]);
  const [student, setStudent] = useState('');
  const [yearId, setYearId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onIncoming((f) => {
        setFiles(f);
        setTitles(f.map((x) => x.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()));
      }),
    [],
  );

  const years = groupsOf('album').filter(isSchoolYear);
  useEffect(() => {
    if (!yearId) setYearId(years.find((y) => y.name.replace(/\s/g, '') === currentSchoolYear())?.id ?? '');
  }, [years.length]);

  if (!files.length) return null;

  // Same name and size as a file already in the library: probably a duplicate.
  const existing = (f: File) => store.all('song').find((s) => s.files.some((x) => x.name === f.name && x.size === f.size));
  const students = groupsOf('artist');
  const collections = groupsOf('collection');

  async function groupFor(type: GroupType, name: string): Promise<string | undefined> {
    const n = name.trim();
    if (!n) return undefined;
    const g = groupsOf(type).find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (g) return g.id;
    const created: Group = { id: uid(), kind: 'group', type, name: n, updatedAt: 0, deviceId: '' };
    await store.put(created);
    return created.id;
  }

  async function add(open: boolean) {
    setBusy(true);
    try {
      const songs = await importFiles(files);
      const artist = await groupFor('artist', student);
      const groups: Song['groups'] = {};
      if (artist) groups.artist = [artist];
      if (yearId) groups.album = [yearId];
      if (collectionId) groups.collection = [collectionId];
      await store.put(songs.map((s, i) => ({ ...s, title: titles[i]?.trim() || s.title, groups })));
      clearIncoming();
      if (open) go({ name: 'reader', songIds: songs.map((s) => s.id) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="picker-overlay">
      <div class="screen">
        <header class="topbar">
          <h1>Ajouter à Partitions</h1>
          <button class="icon" title="Ignorer" onClick={clearIncoming}>
            ✕
          </button>
        </header>
        <div class="form">
          {files.map((f, i) => {
            const dup = existing(f);
            return (
              <label key={i}>
                {files.length > 1 ? `Titre ${i + 1}` : 'Titre'} <small>({f.name})</small>
                <input value={titles[i]} onInput={(e) => setTitles(titles.map((t, j) => (j === i ? (e.target as HTMLInputElement).value : t)))} />
                {dup && <span class="error">Déjà dans la bibliothèque : « {dup.title} »</span>}
              </label>
            );
          })}
          <label>
            Élève (facultatif)
            <input list="incoming-students" value={student} placeholder="Choisir ou taper un nom" onInput={(e) => setStudent((e.target as HTMLInputElement).value)} />
            <datalist id="incoming-students">
              {students.map((s) => (
                <option value={s.name} />
              ))}
            </datalist>
          </label>
          <label>
            Année scolaire
            <select value={yearId} onChange={(e) => setYearId((e.target as HTMLSelectElement).value)}>
              <option value="">Aucune</option>
              {years.map((y) => (
                <option value={y.id}>{y.name}</option>
              ))}
            </select>
          </label>
          <label>
            Collection
            <select value={collectionId} onChange={(e) => setCollectionId((e.target as HTMLSelectElement).value)}>
              <option value="">Aucune</option>
              {collections.map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <div class="row-buttons">
            <button class="primary" disabled={busy} onClick={() => add(true)}>
              {busy ? 'Ajout…' : 'Ajouter et ouvrir'}
            </button>
            <button disabled={busy} onClick={() => add(false)}>
              Ajouter
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
