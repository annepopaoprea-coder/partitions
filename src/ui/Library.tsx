import { useMemo, useRef, useState } from 'preact/hooks';
import { go, SyncBadge } from '../app';
import { GROUP_LABELS, GROUP_TYPES, uid, type Group, type GroupType, type Song } from '../model';
import { ArtistTree } from './ArtistTree';
import { lockConfig, lockNow } from './Lock';
import { collator, groupNames, groupsOf, importFiles, normalize, store, useStore } from '../services';

type Tab = 'songs' | 'setlists' | GroupType;

const TABS: { id: Tab; label: string }[] = [
  { id: 'songs', label: 'Morceaux' },
  { id: 'setlists', label: 'Setlists' },
  ...GROUP_TYPES.map((t) => ({ id: t as Tab, label: GROUP_LABELS[t].many })),
];

type Sort = 'title' | 'recent';

// Remembered while the app is open, so coming back from a song keeps the list.
const ui = { tab: 'songs' as Tab, query: '', filter: null as Group | null, sort: 'title' as Sort, artistList: false };

export function Library() {
  useStore();
  const [tab, setTabState] = useState<Tab>(ui.tab);
  const [query, setQueryState] = useState(ui.query);
  const [filter, setFilterState] = useState<Group | null>(ui.filter);
  const [sort, setSortState] = useState<Sort>(ui.sort);
  const setTab = (t: Tab) => setTabState((ui.tab = t));
  const setQuery = (q: string) => setQueryState((ui.query = q));
  const setFilter = (g: Group | null) => setFilterState((ui.filter = g));
  const setSort = (s: Sort) => setSortState((ui.sort = s));
  const [artistList, setArtistListState] = useState(ui.artistList);
  const setArtistList = (v: boolean) => setArtistListState((ui.artistList = v));
  const input = useRef<HTMLInputElement>(null);

  const songs = store.all('song');
  const visible = useMemo(() => {
    const q = normalize(query.trim());
    let list = songs;
    if (filter) list = list.filter((s) => s.groups[filter.type]?.includes(filter.id));
    if (q) {
      list = list.filter((s) => {
        const hay = [s.title, s.key ?? '', ...GROUP_TYPES.flatMap((t) => groupNames(s, t))].join(' ');
        return normalize(hay).includes(q);
      });
    }
    return [...list].sort((a, b) =>
      sort === 'recent' ? b.updatedAt - a.updatedAt : collator.compare(a.title, b.title),
    );
  }, [songs, query, filter, sort]);

  async function onImport(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    (e.target as HTMLInputElement).value = '';
    if (!files.length) return;
    const added = await importFiles(files);
    if (filter) {
      await store.put(
        added.map((s) => ({ ...s, groups: { ...s.groups, [filter.type]: [filter.id] } })),
      );
    }
    if (added.length === 1) go({ name: 'song', id: added[0].id });
  }

  return (
    <div class="screen">
      <header class="topbar">
        <h1>Partitions</h1>
        <SyncBadge />
        {lockConfig() && (
          <button class="icon" title="Verrouiller" onClick={lockNow}>
            🔒
          </button>
        )}
        <button class="icon" title="Accordeur" onClick={() => go({ name: 'tuner' })}>
          𝄞
        </button>
        <button class="icon" title="Corbeille" onClick={() => go({ name: 'trash' })}>
          🗑
        </button>
        <button class="icon" title="Réglages" onClick={() => go({ name: 'settings' })}>
          ⚙
        </button>
      </header>
      <nav class="tabs">
        {TABS.map((t) => (
          <button
            class={tab === t.id ? 'active' : ''}
            onClick={() => {
              setTab(t.id);
              if (t.id === 'songs') setFilter(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'songs' && (
        <>
          <div class="toolbar">
            <input
              type="search"
              placeholder="Rechercher un titre, un élève, un compositeur…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
            <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
              <option value="title">A → Z</option>
              <option value="recent">Récents</option>
            </select>
            <button class="primary" onClick={() => input.current?.click()}>
              + Importer
            </button>
            <input ref={input} type="file" accept="application/pdf,image/*" multiple hidden onChange={onImport} />
          </div>
          {filter && (
            <div class="filter-chip">
              {GROUP_LABELS[filter.type].one} : <b>{filter.name}</b>
              <button onClick={() => setFilter(null)}>✕</button>
            </div>
          )}
          <SongList songs={visible} />
        </>
      )}

      {tab === 'setlists' && <SetlistList />}

      {tab === 'artist' && !artistList && <ArtistTree onShowList={() => setArtistList(true)} />}

      {GROUP_TYPES.includes(tab as GroupType) && (tab !== 'artist' || artistList) && (
        <GroupList
          onTree={tab === 'artist' ? () => setArtistList(false) : undefined}
          type={tab as GroupType}
          onOpen={(g) => {
            setFilter(g);
            setTab('songs');
          }}
        />
      )}
    </div>
  );
}

function SongList({ songs }: { songs: Song[] }) {
  if (!songs.length) return <p class="empty">Aucun morceau. Utilisez « + Importer » pour ajouter des PDF ou des images.</p>;
  return (
    <ul class="list">
      {songs.map((s) => {
        const sub = [groupNames(s, 'artist'), groupNames(s, 'composer'), groupNames(s, 'album'), groupNames(s, 'collection')]
          .flat()
          .join(' · ');
        return (
          <li key={s.id}>
            <button class="row" onClick={() => go({ name: 'reader', songIds: [s.id] })}>
              <span class="title">{s.title}</span>
              {sub && <span class="sub">{sub}</span>}
            </button>
            <button class="icon" title="Modifier" onClick={() => go({ name: 'song', id: s.id })}>
              ✎
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function GroupList({ type, onOpen, onTree }: { type: GroupType; onOpen: (g: Group) => void; onTree?: () => void }) {
  const groups = groupsOf(type);
  const songs = store.all('song');
  const count = (g: Group) => songs.filter((s) => s.groups[type]?.includes(g.id)).length;
  async function add() {
    const name = prompt(`Nouveau : ${GROUP_LABELS[type].one}`)?.trim();
    if (name) await store.put({ id: uid(), kind: 'group', type, name, updatedAt: 0, deviceId: '' });
  }
  async function rename(g: Group) {
    const name = prompt('Nouveau nom', g.name)?.trim();
    if (name && name !== g.name) await store.put({ ...g, name });
  }
  async function remove(g: Group) {
    if (!confirm(`Mettre « ${g.name} » à la corbeille ? Les morceaux ne sont pas supprimés.`)) return;
    await store.remove(g);
  }
  return (
    <>
      <div class="toolbar">
        <button class="primary" onClick={add}>
          + {GROUP_LABELS[type].one}
        </button>
        {onTree && <button onClick={onTree}>Par année scolaire</button>}
      </div>
      <ul class="list">
        {groups.map((g) => (
          <li key={g.id}>
            <button class="row" onClick={() => onOpen(g)}>
              <span class="title">{g.name}</span>
              <span class="count">{count(g)}</span>
            </button>
            <button class="icon" title="Renommer" onClick={() => rename(g)}>
              ✎
            </button>
            <button class="icon danger" title="Supprimer" onClick={() => remove(g)}>
              🗑
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function SetlistList() {
  const lists = store.all('setlist').sort((a, b) => collator.compare(a.name, b.name));
  async function add() {
    const name = prompt('Nom de la setlist')?.trim();
    if (!name) return;
    const id = uid();
    await store.put({ id, kind: 'setlist', name, songIds: [], createdAt: Date.now(), updatedAt: 0, deviceId: '' });
    go({ name: 'setlist', id });
  }
  return (
    <>
      <div class="toolbar">
        <button class="primary" onClick={add}>
          + Setlist
        </button>
      </div>
      <ul class="list">
        {lists.map((l) => (
          <li key={l.id}>
            <button class="row" onClick={() => go({ name: 'setlist', id: l.id })}>
              <span class="title">{l.name}</span>
              <span class="count">{l.songIds.filter((id) => store.get(id)).length}</span>
            </button>
            <button
              class="icon"
              title="Jouer"
              onClick={() => go({ name: 'reader', songIds: l.songIds.filter((id) => store.get(id)), title: l.name })}
            >
              ▶
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
