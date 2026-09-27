import { useState } from 'preact/hooks';
import { back, go } from '../app';
import type { Setlist, Song } from '../model';
import { collator, groupNames, normalize, store, useStore } from '../services';
import { ExportButton } from './ExportButton';

export function SetlistView({ id }: { id: string }) {
  useStore();
  const [picking, setPicking] = useState(false);
  const list = store.get<Setlist>(id);
  if (!list) {
    return (
      <div class="screen">
        <header class="topbar">
          <button class="icon" onClick={back}>
            ←
          </button>
          <h1>Setlist introuvable</h1>
        </header>
      </div>
    );
  }
  const songs = list.songIds.map((sid) => store.get<Song>(sid)).filter(Boolean) as Song[];
  const ids = songs.map((s) => s.id);
  const save = (patch: Partial<Setlist>) => store.put({ ...list, ...patch });

  const move = (i: number, d: number) => {
    const next = [...ids];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    void save({ songIds: next });
  };

  if (picking)
    return (
      <SongPicker
        initial={ids}
        onDone={(chosen) => {
          setPicking(false);
          if (chosen) void save({ songIds: chosen });
        }}
      />
    );

  return (
    <div class="screen">
      <header class="topbar">
        <button class="icon" onClick={back}>
          ←
        </button>
        <h1
          class="editable"
          onClick={() => {
            const name = prompt('Nom de la setlist', list.name)?.trim();
            if (name) void save({ name });
          }}
        >
          {list.name} ✎
        </h1>
        <button class="primary" disabled={!ids.length} onClick={() => go({ name: 'reader', songIds: ids, title: list.name })}>
          ▶ Jouer
        </button>
      </header>
      <div class="toolbar">
        <button onClick={() => setPicking(true)}>+ Ajouter / retirer des morceaux</button>
        <ExportButton title={list.name} songs={songs} label="📄 Envoyer en PDF" />
        <button
          class="danger"
          onClick={async () => {
            if (confirm(`Mettre la setlist « ${list.name} » à la corbeille ?`)) {
              await store.remove(list);
              back();
            }
          }}
        >
          Supprimer
        </button>
      </div>
      <ol class="list numbered">
        {songs.map((s, i) => (
          <li key={s.id}>
            <button class="row" onClick={() => go({ name: 'reader', songIds: ids, start: i, title: list.name })}>
              <span class="title">{s.title}</span>
            </button>
            <button class="icon" disabled={i === 0} onClick={() => move(i, -1)} title="Monter">
              ↑
            </button>
            <button class="icon" disabled={i === songs.length - 1} onClick={() => move(i, 1)} title="Descendre">
              ↓
            </button>
            <button class="icon danger" onClick={() => save({ songIds: ids.filter((x) => x !== s.id) })} title="Retirer">
              ✕
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function SongPicker({
  initial,
  onDone,
  title,
}: {
  initial: string[];
  onDone: (ids: string[] | null) => void;
  title?: string;
}) {
  const [chosen, setChosen] = useState<string[]>(initial);
  const [query, setQuery] = useState('');
  const q = normalize(query);
  const songs = store
    .all('song')
    .filter((s) => !q || normalize([s.title, ...groupNames(s, 'artist'), ...groupNames(s, 'composer')].join(' ')).includes(q))
    .sort((a, b) => collator.compare(a.title, b.title));
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <div class="screen">
      <header class="topbar">
        <button class="icon" onClick={() => onDone(null)}>
          ←
        </button>
        <h1>{title ? `${title} · ` : ''}{chosen.length} morceau(x)</h1>
        <button class="primary" onClick={() => onDone(chosen)}>
          OK
        </button>
      </header>
      <div class="toolbar">
        <input type="search" placeholder="Rechercher…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </div>
      <ul class="list">
        {songs.map((s) => (
          <li key={s.id}>
            <label class="row check">
              <input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} />
              <span class="title">{s.title}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
