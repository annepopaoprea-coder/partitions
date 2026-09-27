// Artists tab as a tree: school year → student → the songs of their program.
// Years are the albums named like "2025-2026"; students are artists.

import { useState } from 'preact/hooks';
import { go } from '../app';
import { uid, type Group, type Song } from '../model';
import { collator, groupsOf, normalize, store } from '../services';
import { ExportButton } from './ExportButton';
import { SongPicker } from './Setlists';

const YEAR = /^\s*(\d{4})\s*[-–/]\s*(\d{4})\s*$/;
const NO_YEAR = '__none__';

export function isSchoolYear(g: Group) {
  return g.type === 'album' && YEAR.test(g.name);
}

// "2025-2026" from September 2025 to August 2026.
export function currentSchoolYear(d = new Date()) {
  const y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${y + 1}`;
}

const yearStart = (g: Group) => Number(YEAR.exec(g.name)?.[1] ?? 0);

// Expanded nodes survive going to a song and back.
const open = new Set<string>();
let initialised = false;

interface Program {
  student: Group;
  songs: Song[];
}

function programs(yearId: string | null, songs: Song[]): Program[] {
  const years = new Set(groupsOf('album').filter(isSchoolYear).map((g) => g.id));
  const byStudent = new Map<string, Song[]>();
  for (const s of songs) {
    const sYears = (s.groups.album ?? []).filter((id) => years.has(id));
    const inYear = yearId ? sYears.includes(yearId) : sYears.length === 0;
    if (!inYear) continue;
    for (const a of s.groups.artist ?? []) {
      if (!byStudent.has(a)) byStudent.set(a, []);
      byStudent.get(a)!.push(s);
    }
  }
  return [...byStudent]
    .map(([id, list]) => ({ student: store.get<Group>(id)!, songs: list.sort((a, b) => collator.compare(a.title, b.title)) }))
    .filter((p) => p.student)
    .sort((a, b) => collator.compare(a.student.name, b.student.name));
}

export function ArtistTree({ onShowList }: { onShowList: () => void }) {
  const [, rerender] = useState(0);
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState<{ student: Group; year: Group | null } | null>(null);
  const [filing, setFiling] = useState<{ student: Group; songs: Song[] } | null>(null);
  const toggle = (key: string) => {
    if (open.has(key)) open.delete(key);
    else open.add(key);
    rerender((n) => n + 1);
  };

  const years = groupsOf('album')
    .filter(isSchoolYear)
    .sort((a, b) => yearStart(b) - yearStart(a));
  if (!initialised) {
    initialised = true;
    const current = years.find((y) => y.name.replace(/\s/g, '').replace('–', '-') === currentSchoolYear()) ?? years[0];
    if (current) open.add(current.id);
  }

  const songs = store.all('song');
  const q = normalize(query.trim());
  const matches = (p: Program) =>
    !q || normalize(p.student.name).includes(q) || p.songs.some((s) => normalize(s.title).includes(q));

  async function addYear() {
    const name = prompt('Nouvelle année scolaire', nextYearName(years))?.trim();
    if (!name) return;
    if (!YEAR.test(name)) return alert('Écrivez l’année sous la forme 2026-2027.');
    const existing = years.find((y) => y.name === name);
    const id = existing?.id ?? uid();
    if (!existing) await store.put({ id, kind: 'group', type: 'album', name, updatedAt: 0, deviceId: '' });
    open.add(id);
    rerender((n) => n + 1);
  }

  async function addStudent(year: Group | null) {
    const name = prompt(`Nom de l'élève${year ? ` (${year.name})` : ''}`)?.trim();
    if (!name) return;
    let student = groupsOf('artist').find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!student) {
      student = { id: uid(), kind: 'group', type: 'artist', name, updatedAt: 0, deviceId: '' };
      await store.put(student);
    }
    setPicker({ student, year });
  }

  // Add the chosen songs to this student's program for that year.
  async function addSongs(student: Group, year: Group | null, ids: string[]) {
    const updates: Song[] = [];
    for (const id of ids) {
      const s = store.get<Song>(id);
      if (!s) continue;
      const artists = s.groups.artist ?? [];
      const albums = s.groups.album ?? [];
      const needArtist = !artists.includes(student.id);
      const needYear = year && !albums.includes(year.id);
      if (!needArtist && !needYear) continue;
      updates.push({
        ...s,
        groups: {
          ...s.groups,
          artist: needArtist ? [...artists, student.id] : artists,
          album: needYear ? [...albums, year!.id] : albums,
        },
      });
    }
    if (updates.length) await store.put(updates);
  }

  async function removeFromProgram(song: Song, student: Group, year: Group | null) {
    const otherStudents = (song.groups.artist ?? []).filter((a) => a !== student.id);
    const msg = `Retirer « ${song.title} » du programme de ${student.name}${year ? ` (${year.name})` : ''} ?`;
    if (!confirm(msg)) return;
    // The song keeps its year if other students still work on it.
    const album = year && !otherStudents.length ? (song.groups.album ?? []).filter((a) => a !== year.id) : song.groups.album;
    await store.put({ ...song, groups: { ...song.groups, artist: otherStudents, album } });
  }

  // Put every year-less song of this student into the chosen school year.
  async function fileIntoYear(student: Group, list: Song[], year: Group) {
    const shared = list.filter((s) => (s.groups.artist ?? []).some((a) => a !== student.id));
    const others = [
      ...new Set(shared.flatMap((s) => (s.groups.artist ?? []).filter((a) => a !== student.id))),
    ]
      .map((id) => store.get<Group>(id)?.name)
      .filter(Boolean);
    const msg =
      `Ranger ${list.length} morceau${list.length > 1 ? 'x' : ''} de ${student.name} dans ${year.name} ?` +
      (others.length ? `\n\n${shared.length} de ces morceaux sont aussi travaillés par ${others.join(', ')} : ils passeront aussi en ${year.name}.` : '');
    if (!confirm(msg)) return;
    await store.put(list.map((s) => ({ ...s, groups: { ...s.groups, album: [...(s.groups.album ?? []), year.id] } })));
    setFiling(null);
    open.add(year.id);
    open.add(`${year.id}/${student.id}`);
  }

  if (filing) {
    return (
      <div class="picker-overlay">
        <div class="screen">
          <header class="topbar">
            <button class="icon" onClick={() => setFiling(null)}>
              ←
            </button>
            <h1>Ranger les morceaux de {filing.student.name}</h1>
          </header>
          <p class="hint year-hint">
            {filing.songs.length} morceau{filing.songs.length > 1 ? 'x' : ''} sans année scolaire. Choisissez l'année :
          </p>
          <ul class="year-choices">
            {years.map((y) => (
              <li key={y.id}>
                <button class="row" onClick={() => fileIntoYear(filing.student, filing.songs, y)}>
                  <span class="title">{y.name}</span>
                </button>
              </li>
            ))}
          </ul>
          <div class="toolbar">
            <button onClick={addYear}>+ Nouvelle année scolaire</button>
          </div>
        </div>
      </div>
    );
  }

  if (picker) {
    const current = programs(picker.year?.id ?? null, songs).find((p) => p.student.id === picker.student.id);
    const initial = current?.songs.map((s) => s.id) ?? [];
    return (
      <div class="picker-overlay">
        <SongPicker
          title={`${picker.student.name}${picker.year ? ` · ${picker.year.name}` : ''}`}
          initial={initial}
          onDone={async (ids) => {
            const { student, year } = picker;
            setPicker(null);
            if (ids) {
              await addSongs(student, year, ids.filter((id) => !initial.includes(id)));
              open.add(year?.id ?? NO_YEAR);
              open.add(`${year?.id ?? NO_YEAR}/${student.id}`);
            }
          }}
        />
      </div>
    );
  }

  const nodes: { year: Group | null; key: string; label: string }[] = [
    ...years.map((y) => ({ year: y, key: y.id, label: y.name })),
    { year: null, key: NO_YEAR, label: 'Sans année scolaire' },
  ];

  return (
    <>
      <div class="toolbar">
        <input type="search" placeholder="Rechercher un élève ou un morceau…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <button class="primary" onClick={addYear}>
          + Année scolaire
        </button>
        <button onClick={onShowList}>Liste simple</button>
      </div>
      <ul class="tree">
        {nodes.map(({ year, key, label }) => {
          const progs = programs(year?.id ?? null, songs).filter(matches);
          if (!year && !progs.length) return null;
          const isOpen = open.has(key) || !!q;
          return (
            <li key={key}>
              <div class="node year">
                <button class="node-label" onClick={() => toggle(key)}>
                  <span class="caret">{isOpen ? '▾' : '▸'}</span>
                  <b>{label}</b>
                  <span class="count">
                    {progs.length} élève{progs.length > 1 ? 's' : ''}
                  </span>
                </button>
                <button class="icon" title="Ajouter un élève" onClick={() => addStudent(year)}>
                  ＋
                </button>
              </div>
              {isOpen && (
                <ul>
                  {!progs.length && <li class="hint tree-empty">Aucun élève. Touchez ＋ pour en ajouter un.</li>}
                  {progs.map(({ student, songs: list }) => {
                    const skey = `${key}/${student.id}`;
                    const sOpen = open.has(skey) || !!q;
                    const shown = q && !normalize(student.name).includes(q) ? list.filter((s) => normalize(s.title).includes(q)) : list;
                    return (
                      <li key={skey}>
                        <div class="node student">
                          <button class="node-label" onClick={() => toggle(skey)}>
                            <span class="caret">{sOpen ? '▾' : '▸'}</span>
                            {student.name}
                            <span class="count">{list.length}</span>
                          </button>
                          <button
                            class="icon"
                            title="Jouer le programme"
                            onClick={() => go({ name: 'reader', songIds: list.map((s) => s.id), title: `${student.name}${year ? ` · ${year.name}` : ''}` })}
                          >
                            ▶
                          </button>
                          {!year && (
                            <button class="file-year" onClick={() => setFiling({ student, songs: list })}>
                              Ranger dans une année
                            </button>
                          )}
                          <ExportButton title={student.name} subtitle={year ? `Programme ${year.name}` : 'Programme'} songs={list} />
                          <button class="icon" title="Ajouter des morceaux" onClick={() => setPicker({ student, year })}>
                            ＋
                          </button>
                        </div>
                        {sOpen && (
                          <ul>
                            {shown.map((s) => (
                              <li key={s.id} class="node song">
                                <button class="node-label" onClick={() => go({ name: 'reader', songIds: [s.id] })}>
                                  {s.title}
                                </button>
                                <button class="icon" title="Modifier" onClick={() => go({ name: 'song', id: s.id })}>
                                  ✎
                                </button>
                                <button class="icon danger" title="Retirer du programme" onClick={() => removeFromProgram(s, student, year)}>
                                  ✕
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function nextYearName(years: Group[]) {
  const latest = years.length ? yearStart(years[0]) : Number(currentSchoolYear().slice(0, 4)) - 1;
  return `${latest + 1}-${latest + 2}`;
}
