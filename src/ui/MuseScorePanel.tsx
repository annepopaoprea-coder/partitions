import { useState } from 'preact/hooks';
import { go } from '../app';
import { addResults, displayedOf, openInMuseScore, runJob, sourceOf, useBridge } from '../bridge';
import type { Song } from '../model';

// Key signatures by number of sharps (+) or flats (−), for transposition.
const KEYS: { fifths: number; label: string }[] = [
  { fifths: 0, label: 'Do majeur / la mineur' },
  { fifths: 1, label: 'Sol majeur / mi mineur (1♯)' },
  { fifths: 2, label: 'Ré majeur / si mineur (2♯)' },
  { fifths: 3, label: 'La majeur / fa♯ mineur (3♯)' },
  { fifths: 4, label: 'Mi majeur / do♯ mineur (4♯)' },
  { fifths: 5, label: 'Si majeur / sol♯ mineur (5♯)' },
  { fifths: -1, label: 'Fa majeur / ré mineur (1♭)' },
  { fifths: -2, label: 'Si♭ majeur / sol mineur (2♭)' },
  { fifths: -3, label: 'Mi♭ majeur / do mineur (3♭)' },
  { fifths: -4, label: 'La♭ majeur / fa mineur (4♭)' },
  { fifths: -5, label: 'Ré♭ majeur / si♭ mineur (5♭)' },
];

const CLEFS: { id: string; label: string }[] = [
  { id: 'G', label: 'Clé de sol' },
  { id: 'G1', label: 'Clé de sol 1re ligne (violon français)' },
  { id: 'C1', label: 'Clé d’ut 1re ligne (soprano)' },
  { id: 'C3', label: 'Clé d’ut 3e ligne (alto)' },
  { id: 'C4', label: 'Clé d’ut 4e ligne (ténor)' },
  { id: 'F', label: 'Clé de fa' },
  { id: 'G8vb', label: 'Clé de sol octaviée' },
];

type Mode = null | 'transpose' | 'clef';

// "MuseScore (sur ce PC)" section of a song: only shown where the bridge runs.
export function MuseScorePanel({ song }: { song: Song }) {
  const bridge = useBridge();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [key, setKey] = useState(0);
  const [direction, setDirection] = useState('closest');
  const [parts, setParts] = useState<{ id: string; name: string }[]>([]);
  const [part, setPart] = useState('');
  const [clef, setClef] = useState('C3');
  if (!bridge?.musescore) return null;

  const src = sourceOf(song);
  const shown = displayedOf(song);

  async function work(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setMsg('');
    try {
      setMsg(await fn());
    } catch (e) {
      setMsg(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  const created = (songs: Song[]) => (songs.length === 1 ? `Ajouté : « ${songs[0].title} »` : `Ajoutés : ${songs.map((s) => `« ${s.title} »`).join(', ')}`);

  return (
    <section class="musescore">
      <h2>MuseScore (sur ce PC)</h2>
      {!src ? (
        <>
          <p class="hint">
            Ce morceau n'est qu'un PDF (une image de la partition). Pour le transposer, changer de clé ou le modifier, il faut
            d'abord le convertir en partition MuseScore. La reconnaissance est bonne sur une édition propre, moins sur un
            manuscrit ou un vieux scan : il faudra souvent corriger dans MuseScore.
          </p>
          <button
            class="primary"
            disabled={!!busy || !bridge.audiveris || !shown}
            onClick={() =>
              work('Reconnaissance de la partition (Audiveris)… cela peut prendre plusieurs minutes', async () => {
                const songs = await addResults(song, await runJob('omr', song, shown!));
                go({ name: 'song', id: songs[0].id });
                return `${created(songs)}. Ouvrez-le dans MuseScore pour vérifier et corriger.`;
              })
            }
          >
            Convertir le PDF en partition MuseScore
          </button>
          {!bridge.audiveris && <p class="hint">Audiveris n'est pas encore installé sur ce PC.</p>}
        </>
      ) : (
        <>
          <div class="row-buttons">
            <button
              class="primary"
              disabled={!!busy}
              onClick={() =>
                work('Ouverture dans MuseScore…', async () => {
                  await openInMuseScore(song);
                  return 'Ouvert dans MuseScore. Chaque enregistrement (Ctrl+S) met à jour ce morceau dans Partitions.';
                })
              }
            >
              Ouvrir dans MuseScore
            </button>
            <button disabled={!!busy} onClick={() => setMode(mode === 'transpose' ? null : 'transpose')}>
              Transposer…
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                work('Extraction des parties…', async () => created(await addResults(song, await runJob('parts', song, src))))
              }
            >
              Extraire les parties
            </button>
            <button
              disabled={!!busy}
              onClick={async () => {
                if (mode === 'clef') return setMode(null);
                await work('Lecture des parties…', async () => {
                  const info = await runJob<{ parts: { id: string; name: string }[] }>('info', song, src);
                  setParts(info.parts);
                  setPart(info.parts[0]?.id ?? '');
                  setMode('clef');
                  return '';
                });
              }}
            >
              Changer de clé…
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                work('Basse chiffrée…', async () => {
                  const info = await runJob<{ figures: number }>('info', song, src);
                  if (!info.figures)
                    return 'Pas de basse chiffrée dans cette partition. Dans MuseScore : sélectionnez une note de la basse, puis Ctrl+G pour écrire les chiffres.';
                  return created(await addResults(song, await runJob('figures', song, src, { show: false })));
                })
              }
            >
              Version sans basse chiffrée
            </button>
          </div>

          {mode === 'transpose' && (
            <div class="sub-form">
              <label>
                Nouvelle tonalité
                <select value={key} onChange={(e) => setKey(Number((e.target as HTMLSelectElement).value))}>
                  {KEYS.map((k) => (
                    <option value={k.fifths}>{k.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Sens
                <select value={direction} onChange={(e) => setDirection((e.target as HTMLSelectElement).value)}>
                  <option value="closest">Le plus proche</option>
                  <option value="up">Vers l'aigu</option>
                  <option value="down">Vers le grave</option>
                </select>
              </label>
              <button
                class="primary"
                disabled={!!busy}
                onClick={() =>
                  work('Transposition…', async () => {
                    const label = `en ${KEYS.find((k) => k.fifths === key)!.label.split(' /')[0]}`;
                    const songs = await addResults(song, await runJob('transpose', song, src, { key, direction, label }));
                    setMode(null);
                    return created(songs);
                  })
                }
              >
                Transposer
              </button>
            </div>
          )}

          {mode === 'clef' && (
            <div class="sub-form">
              {parts.length > 1 && (
                <label>
                  Partie
                  <select value={part} onChange={(e) => setPart((e.target as HTMLSelectElement).value)}>
                    {parts.map((p) => (
                      <option value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Nouvelle clé
                <select value={clef} onChange={(e) => setClef((e.target as HTMLSelectElement).value)}>
                  {CLEFS.map((c) => (
                    <option value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
              <button
                class="primary"
                disabled={!!busy}
                onClick={() =>
                  work('Changement de clé…', async () => {
                    const label = CLEFS.find((c) => c.id === clef)!.label.toLowerCase();
                    const songs = await addResults(song, await runJob('clef', song, src, { part, clef, label }));
                    setMode(null);
                    return created(songs);
                  })
                }
              >
                Changer la clé
              </button>
            </div>
          )}
        </>
      )}
      {busy && <p class="hint">⏳ {busy}</p>}
      {msg && <p class={msg.startsWith('⚠') ? 'error' : 'hint'}>{msg}</p>}
    </section>
  );
}
