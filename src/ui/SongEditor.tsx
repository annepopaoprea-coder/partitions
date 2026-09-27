import { useRef, useState } from 'preact/hooks';
import { back, go } from '../app';
import { GROUP_LABELS, GROUP_TYPES, uid, type Group, type GroupType, type Song } from '../model';
import { addFile, groupsOf, store, useStore } from '../services';

export function SongEditor({ id }: { id: string }) {
  useStore();
  const song = store.get<Song>(id);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!song) {
    return (
      <div class="screen">
        <header class="topbar">
          <button class="icon" onClick={back}>
            ←
          </button>
          <h1>Morceau introuvable</h1>
        </header>
      </div>
    );
  }
  const save = (patch: Partial<Song>) => store.put({ ...song, ...patch });

  async function addFiles(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    (e.target as HTMLInputElement).value = '';
    const refs = [];
    for (const f of files) refs.push(await addFile(f));
    await save({ files: [...song!.files, ...refs] });
  }

  async function remove() {
    if (!confirm(`Supprimer « ${song!.title} » sur tous les appareils ?`)) return;
    await store.remove(song!);
    back();
  }

  return (
    <div class="screen">
      <header class="topbar">
        <button class="icon" onClick={back}>
          ←
        </button>
        <h1>Modifier</h1>
        <button class="primary" onClick={() => go({ name: 'reader', songIds: [song.id] })}>
          Ouvrir
        </button>
      </header>
      <div class="form">
        <label>
          Titre
          <input value={song.title} onChange={(e) => save({ title: (e.target as HTMLInputElement).value.trim() || song.title })} />
        </label>
        {GROUP_TYPES.map((t) => (
          <GroupField key={t} song={song} type={t} />
        ))}
        <label>
          Tonalité
          <input value={song.key ?? ''} onChange={(e) => save({ key: (e.target as HTMLInputElement).value.trim() })} />
        </label>
        <label>
          Notes
          <textarea rows={4} value={song.notes ?? ''} onChange={(e) => save({ notes: (e.target as HTMLTextAreaElement).value })} />
        </label>
        <div class="field">
          <span>Fichiers</span>
          <ul class="files">
            {song.files.map((f, i) => (
              <li key={f.id}>
                {f.name} <small>({(f.size / 1e6).toFixed(1)} Mo)</small>
                <button
                  class="icon"
                  disabled={i === 0}
                  title="Monter"
                  onClick={() => {
                    const files = [...song.files];
                    [files[i - 1], files[i]] = [files[i], files[i - 1]];
                    void save({ files });
                  }}
                >
                  ↑
                </button>
                <button class="icon danger" title="Retirer" onClick={() => save({ files: song.files.filter((x) => x !== f) })}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => fileInput.current?.click()}>+ Ajouter un fichier</button>
          <input ref={fileInput} type="file" accept="application/pdf,image/*" multiple hidden onChange={addFiles} />
        </div>
        <button class="danger wide" onClick={remove}>
          Supprimer le morceau
        </button>
      </div>
    </div>
  );
}

function GroupField({ song, type }: { song: Song; type: GroupType }) {
  const [text, setText] = useState('');
  const all = groupsOf(type);
  const selected = (song.groups[type] ?? []).map((id) => store.get<Group>(id)).filter(Boolean) as Group[];
  const listId = `dl-${type}`;

  async function add() {
    const name = text.trim();
    if (!name) return;
    let g = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!g) {
      g = { id: uid(), kind: 'group', type, name, updatedAt: 0, deviceId: '' };
      await store.put(g);
    }
    const ids = song.groups[type] ?? [];
    if (!ids.includes(g.id)) await store.put({ ...song, groups: { ...song.groups, [type]: [...ids, g.id] } });
    setText('');
  }

  const removeGroup = (g: Group) =>
    store.put({ ...song, groups: { ...song.groups, [type]: (song.groups[type] ?? []).filter((x) => x !== g.id) } });

  return (
    <div class="field">
      <span>{GROUP_LABELS[type].many}</span>
      <div class="chips">
        {selected.map((g) => (
          <span class="chip" key={g.id}>
            {g.name}
            <button onClick={() => removeGroup(g)}>✕</button>
          </span>
        ))}
        <input
          list={listId}
          placeholder="Ajouter…"
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          onChange={add}
        />
        <datalist id={listId}>
          {all.map((g) => (
            <option value={g.name} />
          ))}
        </datalist>
      </div>
    </div>
  );
}
