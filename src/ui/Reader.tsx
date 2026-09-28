import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { back, go, setBackGuard } from '../app';
import { Frame, inkBox, type PageSetup, type Rotation } from '../frame';
import { Metronome, TapTempo } from '../metronome';
import { annId, uid, type AnnItem, type Link, type PageAnnotations, type Song, type Tool } from '../model';
import { renderPage, songPages, type PageRef } from '../pdf';
import { loadBlob, store, useStore } from '../services';
import { COLORS, drawItem, drawItems, hits, simplify, STAMPS } from './annotate';

const prefs = {
  get halfPage() {
    return localStorage.getItem('reader.halfPage') === '1';
  },
  set halfPage(v: boolean) {
    localStorage.setItem('reader.halfPage', v ? '1' : '0');
  },
  get twoUp() {
    return localStorage.getItem('reader.twoUp') !== '0';
  },
  set twoUp(v: boolean) {
    localStorage.setItem('reader.twoUp', v ? '1' : '0');
  },
};

interface Pen {
  tool: Tool;
  color: string;
  width: number; // fraction of page width
  stamp: string;
}

type Undo = { id: string; song: Song; index: number; items: AnnItem[] };

type Panel = null | 'page' | 'metronome';

const metronome = new Metronome();

export function Reader({ songIds, start = 0, title }: { songIds: string[]; start?: number; title?: string }) {
  useStore();
  const [pages, setPages] = useState<PageRef[] | null>(null);
  const [firstOf, setFirstOf] = useState<number[]>([]);
  const [idx, setIdx] = useState(0);
  const [half, setHalf] = useState(false);
  const [bar, setBar] = useState(true);
  const [editing, setEditing] = useState(false);
  const [concert, setConcert] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [cropping, setCropping] = useState(false);
  const [halfMode, setHalfMode] = useState(prefs.halfPage);
  const [twoUpPref, setTwoUpPref] = useState(prefs.twoUp);
  const [pen, setPen] = useState<Pen>({ tool: 'pen', color: COLORS[0], width: 0.003, stamp: 'p' });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState('');
  const [pulse, setPulse] = useState(-1);
  const undo = useRef<Undo[]>([]);
  const usedLinks = useRef(new Set<string>());
  const box = useRef<HTMLDivElement>(null);

  // Load every page of every song (for setlists, pages run on across songs).
  useEffect(() => {
    let alive = true;
    (async () => {
      const all: PageRef[] = [];
      const firsts: number[] = [];
      for (const id of songIds) {
        const song = store.get<Song>(id);
        firsts.push(all.length);
        if (!song) continue;
        try {
          all.push(...(await songPages(song, loadBlob)));
        } catch (e) {
          console.error(e);
          setError(`Impossible d'ouvrir « ${song.title} » (fichier pas encore téléchargé ?)`);
        }
      }
      if (!alive) return;
      setFirstOf(firsts);
      setPages(all);
      setIdx(Math.min(firsts[start] ?? 0, Math.max(0, all.length - 1)));
    })();
    return () => {
      alive = false;
    };
  }, [songIds.join()]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the screen on while reading.
  useEffect(() => {
    let lock: WakeLockSentinel | undefined;
    const take = () => navigator.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    void take();
    const onVis = () => document.visibilityState === 'visible' && take();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, []);

  // Metronome: visual pulse, stopped when leaving the reader.
  useEffect(() => {
    metronome.onBeat = (b) => {
      setPulse(b);
      setTimeout(() => setPulse(-1), 110);
    };
    return () => metronome.stop();
  }, []);

  // In concert mode the Android back gesture does nothing.
  useEffect(() => {
    setBackGuard(concert ? () => true : null);
    return () => setBackGuard(null);
  }, [concert]);

  const count = pages?.length ?? 0;
  const twoUp = twoUpPref && size.w > size.h * 1.15 && !editing && !cropping;
  const step = twoUp ? 2 : 1;
  const current = pages?.[idx];
  const songIndex = current ? firstOf.findLastIndex((f) => f <= idx) : -1;

  // First page (global index) of the song the page at `at` belongs to.
  const songStart = (at: number) => firstOf[firstOf.findLastIndex((f) => f <= at)] ?? 0;

  // Repeat jumps on the visible pages that have not been played yet.
  function pendingLinks() {
    if (!pages) return [];
    const visible = twoUp ? [idx, idx + 1] : [idx];
    const out: { link: Link; at: number }[] = [];
    for (const at of visible) {
      const ref = pages[at];
      if (!ref) continue;
      const song = store.get<Song>(ref.song.id) ?? ref.song;
      for (const link of song.links ?? []) {
        if (link.page === ref.index && !usedLinks.current.has(link.id)) out.push({ link, at });
      }
    }
    return out.sort((a, b) => a.at - b.at || a.link.y - b.link.y || a.link.x - b.link.x);
  }

  function follow(link: Link, at: number) {
    usedLinks.current.add(link.id);
    setHalf(false);
    setIdx(Math.min(songStart(at) + link.to, Math.max(0, count - 1)));
  }

  const next = () => {
    if (half) {
      setHalf(false);
      setIdx((i) => Math.min(i + 1, Math.max(0, count - 1)));
      return;
    }
    // The pedal (or a tap) takes a pending repeat before moving on.
    const pending = pendingLinks();
    if (pending.length) return follow(pending[0].link, pending[0].at);
    if (halfMode && !twoUp && idx + 1 < count) return setHalf(true);
    setIdx((i) => Math.min(i + step, Math.max(0, count - 1)));
  };
  const prev = () => {
    if (half) return setHalf(false);
    setIdx((i) => Math.max(0, i - step));
  };

  // Page turns: keyboard and Bluetooth pedals (they send arrow/page keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) {
        e.preventDefault();
        next();
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) {
        e.preventDefault();
        prev();
      } else if (e.key === 'Escape' && editing) setEditing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function onTap(e: MouseEvent) {
    if (editing || cropping) return;
    const x = e.clientX / window.innerWidth;
    if (x < 0.3) prev();
    else if (x > 0.7) next();
    else if (!concert) setBar((b) => !b);
  }

  async function saveAnn(ref: PageRef, items: AnnItem[]) {
    const id = annId(ref.song.id, ref.index);
    const prevRec = store.get<PageAnnotations>(id);
    undo.current.push({ id, song: ref.song, index: ref.index, items: prevRec?.items ?? [] });
    await store.put({ id, kind: 'ann', songId: ref.song.id, page: ref.index, items, updatedAt: 0, deviceId: '' });
  }

  async function doUndo() {
    const u = undo.current.pop();
    if (!u) return;
    await store.put({ id: u.id, kind: 'ann', songId: u.song.id, page: u.index, items: u.items, updatedAt: 0, deviceId: '' });
  }

  const liveSong = (ref: PageRef) => store.get<Song>(ref.song.id) ?? ref.song;

  async function saveSong(ref: PageRef, patch: Partial<Song>) {
    await store.put({ ...liveSong(ref), ...patch });
  }

  async function addLink(ref: PageRef, x: number, y: number) {
    const song = liveSong(ref);
    const total = Math.max(...pages!.filter((p) => p.song.id === song.id).map((p) => p.index)) + 1;
    const answer = prompt(`Renvoi vers quelle page de « ${song.title} » ? (1 à ${total})`, '1');
    const to = Number(answer) - 1;
    if (!answer || !Number.isInteger(to) || to < 0 || to >= total) return;
    const label = prompt('Nom du renvoi (ex. : Reprise, D.C., Coda)', to <= ref.index ? 'Reprise' : 'Coda') ?? 'Reprise';
    const link: Link = { id: uid(), page: ref.index, x, y, to, label: label.trim() || 'Reprise' };
    await saveSong(ref, { links: [...(song.links ?? []), link] });
  }

  async function removeLink(ref: PageRef, link: Link) {
    const song = liveSong(ref);
    await saveSong(ref, { links: (song.links ?? []).filter((l) => l.id !== link.id) });
  }

  const slotW = twoUp ? size.w / 2 : size.w;
  const setupOf = (ref?: PageRef): PageSetup | undefined => (ref ? liveSong(ref).pages?.[ref.index] : undefined);
  const view = (ref: PageRef | undefined, w: number, h: number, edit: boolean) => (
    <PageView
      page={ref}
      setup={setupOf(ref)}
      w={w}
      h={h}
      editing={edit}
      cropping={edit && cropping}
      pen={pen}
      onSave={saveAnn}
      onLink={(link, at) => follow(link, at)}
      at={ref ? pages!.indexOf(ref) : -1}
      onAddLink={addLink}
      onRemoveLink={removeLink}
      onCrop={(crop) => {
        setCropping(false);
        const ref2 = ref!;
        const song = liveSong(ref2);
        void saveSong(ref2, { pages: { ...song.pages, [ref2.index]: { ...song.pages?.[ref2.index], crop } } });
      }}
    />
  );

  return (
    <div class={`reader ${concert ? 'concert' : ''}`}>
      <div class="pages" ref={box} onClick={onTap}>
        {pages && size.w > 0 && current && (
          half ? (
            <div class="half">
              <div class="half-top" style={{ height: size.h / 2 }}>
                {view(pages[idx + 1], size.w, size.h, false)}
              </div>
              <div class="half-bottom" style={{ height: size.h / 2 }}>
                <div style={{ marginTop: -size.h / 2 }}>{view(current, size.w, size.h, false)}</div>
              </div>
            </div>
          ) : (
            <>
              {view(current, slotW, size.h, editing || cropping)}
              {twoUp && pages[idx + 1] && view(pages[idx + 1], slotW, size.h, false)}
            </>
          )
        )}
        {pages && !count && (
          <p class="empty">
            {error ||
              (current === undefined && songIds.some((id) => store.get<Song>(id)?.files.every((f) => f.role === 'source'))
                ? 'Partition MuseScore pas encore mise en page : ouvrez Partitions sur le PC où MuseScore est installé.'
                : 'Aucune page à afficher.')}
          </p>
        )}
        {!pages && <p class="empty">Chargement…</p>}
      </div>

      {metronome.running && <div class={`metro-pulse ${pulse === 0 ? 'accent' : pulse > 0 ? 'on' : ''}`} />}

      {concert && <ConcertExit onExit={() => setConcert(false)} />}

      {!concert && (bar || editing || cropping) && (
        <header class="reader-bar" onClick={(e) => e.stopPropagation()}>
          <button class="icon" onClick={back} title="Retour">
            ←
          </button>
          <div class="reader-title">
            <b>{current?.song.title ?? title}</b>
            <small>
              {title && `${title} · ${songIndex + 1}/${songIds.length} · `}
              page {idx + 1}
              {twoUp && idx + 1 < count ? `–${idx + 2}` : ''} / {count}
            </small>
          </div>
          {cropping ? (
            <div class="tools">
              <span class="hint">Dessinez le cadre à garder sur la page.</span>
              <button onClick={() => setCropping(false)}>Annuler</button>
            </div>
          ) : !editing ? (
            <>
              <button class="icon" title="Annoter / renvois" onClick={() => setEditing(true)}>
                ✎
              </button>
              <button class={`icon ${panel === 'page' ? 'on' : ''}`} title="Pivoter / recadrer" onClick={() => setPanel(panel === 'page' ? null : 'page')}>
                ⟳
              </button>
              <button class={`icon ${panel === 'metronome' || metronome.running ? 'on' : ''}`} title="Métronome" onClick={() => setPanel(panel === 'metronome' ? null : 'metronome')}>
                ♩
              </button>
              <button
                class={`icon ${halfMode ? 'on' : ''}`}
                title="Demi-page"
                onClick={() => {
                  prefs.halfPage = !halfMode;
                  setHalfMode(!halfMode);
                  setHalf(false);
                }}
              >
                ½
              </button>
              <button
                class={`icon ${twoUpPref ? 'on' : ''}`}
                title="Deux pages en paysage"
                onClick={() => {
                  prefs.twoUp = !twoUpPref;
                  setTwoUpPref(!twoUpPref);
                }}
              >
                ▯▯
              </button>
              <button
                class="icon"
                title="Mode concert"
                onClick={() => {
                  setPanel(null);
                  setConcert(true);
                  document.documentElement.requestFullscreen?.().catch(() => {});
                }}
              >
                🎻
              </button>
              {current && songIds.length === 1 && (
                <button class="icon" title="Modifier le morceau" onClick={() => go({ name: 'song', id: current.song.id })}>
                  ⚙
                </button>
              )}
            </>
          ) : (
            <Tools pen={pen} setPen={setPen} onUndo={doUndo} onDone={() => setEditing(false)} />
          )}
        </header>
      )}

      {!concert && panel === 'page' && current && (
        <PagePanel
          ref0={current}
          song={liveSong(current)}
          onChange={(pagesPatch) => saveSong(current, { pages: pagesPatch })}
          onDrawCrop={() => {
            setPanel(null);
            setCropping(true);
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {!concert && panel === 'metronome' && current && (
        <MetronomePanel song={liveSong(current)} onSave={(p) => saveSong(current, p)} onClose={() => setPanel(null)} />
      )}

      {!editing && !cropping && !concert && count > 0 && (
        <input
          class="page-slider"
          type="range"
          min={0}
          max={count - 1}
          value={idx}
          style={{ visibility: bar ? 'visible' : 'hidden' }}
          onInput={(e) => {
            setHalf(false);
            usedLinks.current.clear();
            setIdx(Number((e.target as HTMLInputElement).value));
          }}
        />
      )}
    </div>
  );
}

// Leaving concert mode needs a deliberate 1-second press.
function ConcertExit({ onExit }: { onExit: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = (e: Event) => {
    e.stopPropagation();
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      onExit();
    }, 1000);
  };
  const cancel = () => {
    clearTimeout(timer.current);
    setHolding(false);
  };
  return (
    <button
      class={`concert-exit ${holding ? 'holding' : ''}`}
      title="Maintenir pour quitter le mode concert"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onClick={(e) => e.stopPropagation()}
    >
      {holding ? 'Maintenir…' : '🎻'}
    </button>
  );
}

function PagePanel({
  ref0,
  song,
  onChange,
  onDrawCrop,
  onClose,
}: {
  ref0: PageRef;
  song: Song;
  onChange: (pages: Record<number, PageSetup>) => void;
  onDrawCrop: () => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const setup = song.pages?.[ref0.index] ?? {};

  // Apply to this page, or to every page of the song.
  async function apply(fn: (s: PageSetup, index: number) => PageSetup | Promise<PageSetup>) {
    const next: Record<number, PageSetup> = { ...song.pages };
    if (all) {
      const refs = await songPages(song, loadBlob);
      for (const r of refs) next[r.index] = await fn(next[r.index] ?? {}, r.index);
    } else {
      next[ref0.index] = await fn(setup, ref0.index);
    }
    onChange(next);
  }

  const rotate = (d: number) => apply((s) => ({ ...s, rot: ((((s.rot ?? 0) + d) % 360) + 360) % 360 as Rotation, crop: undefined }));

  async function autoCrop() {
    setBusy(true);
    try {
      const refs = all ? await songPages(song, loadBlob) : [ref0];
      const crops = new Map<number, PageSetup['crop']>();
      for (const r of refs) {
        const off = document.createElement('canvas');
        await renderPage(r, off, 900, 900, loadBlob, { rot: song.pages?.[r.index]?.rot });
        crops.set(r.index, inkBox(off) ?? undefined);
      }
      await apply((s, i) => ({ ...s, crop: crops.get(i) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="float-panel" onClick={(e) => e.stopPropagation()}>
      <div class="panel-head">
        <b>Page {ref0.index + 1}</b>
        <button class="icon" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="row-buttons">
        <button onClick={() => rotate(-90)}>⟲ Pivoter à gauche</button>
        <button onClick={() => rotate(90)}>⟳ Pivoter à droite</button>
      </div>
      <div class="row-buttons">
        <button disabled={busy} onClick={autoCrop}>
          {busy ? 'Analyse…' : 'Enlever les marges'}
        </button>
        <button disabled={all} onClick={onDrawCrop}>
          Dessiner le cadre
        </button>
        <button disabled={!setup.rot && !setup.crop && !all} onClick={() => apply(() => ({}))}>
          Réinitialiser
        </button>
      </div>
      <label class="check">
        <input type="checkbox" checked={all} onChange={() => setAll(!all)} />
        Appliquer à toutes les pages du morceau
      </label>
    </div>
  );
}

function MetronomePanel({ song, onSave, onClose }: { song: Song; onSave: (p: Partial<Song>) => void; onClose: () => void }) {
  const [bpm, setBpm] = useState(song.tempo ?? metronome.bpm);
  const [beats, setBeats] = useState(song.beats ?? metronome.beats);
  const [sound, setSound] = useState(metronome.sound);
  const [running, setRunning] = useState(metronome.running);
  const tapper = useRef(new TapTempo());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  metronome.bpm = bpm;
  metronome.beats = beats;
  metronome.sound = sound;

  // The tempo is remembered for this piece.
  const remember = (patch: Partial<Song>) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onSave(patch), 800);
  };
  const changeBpm = (v: number) => {
    const b = Math.max(20, Math.min(300, Math.round(v)));
    setBpm(b);
    remember({ tempo: b, beats });
  };

  return (
    <div class="float-panel metronome" onClick={(e) => e.stopPropagation()}>
      <div class="panel-head">
        <b>Métronome</b>
        <button class="icon" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="bpm">
        <button class="icon" onClick={() => changeBpm(bpm - 1)}>
          −
        </button>
        <span>
          <b>{bpm}</b> ♩/min
        </span>
        <button class="icon" onClick={() => changeBpm(bpm + 1)}>
          +
        </button>
      </div>
      <input type="range" min={20} max={300} value={bpm} onInput={(e) => changeBpm(Number((e.target as HTMLInputElement).value))} />
      <div class="row-buttons">
        <button onClick={() => { const t = tapper.current.tap(); if (t) changeBpm(t); }}>Taper le tempo</button>
        <select
          value={beats}
          onChange={(e) => {
            const b = Number((e.target as HTMLSelectElement).value);
            setBeats(b);
            remember({ tempo: bpm, beats: b });
          }}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map((n) => (
            <option value={n}>{n === 1 ? 'Sans accent' : `${n} temps`}</option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" checked={sound} onChange={() => setSound(!sound)} /> Son
        </label>
      </div>
      <button
        class="primary wide"
        onClick={() => {
          if (metronome.running) metronome.stop();
          else metronome.start();
          setRunning(metronome.running);
        }}
      >
        {running ? '■ Arrêter' : '▶ Démarrer'}
      </button>
    </div>
  );
}

function Tools({ pen, setPen, onUndo, onDone }: { pen: Pen; setPen: (p: Pen) => void; onUndo: () => void; onDone: () => void }) {
  const tools: { t: Tool; label: string; title: string }[] = [
    { t: 'pen', label: '✎', title: 'Crayon' },
    { t: 'highlighter', label: '▍', title: 'Surligneur' },
    { t: 'eraser', label: '⌫', title: 'Gomme' },
    { t: 'text', label: 'T', title: 'Texte' },
    { t: 'stamp', label: '♩', title: 'Tampon' },
    { t: 'link', label: '↩', title: 'Renvoi (reprise, D.C., coda)' },
  ];
  return (
    <div class="tools">
      {tools.map((x) => (
        <button class={`icon ${pen.tool === x.t ? 'on' : ''}`} title={x.title} onClick={() => setPen({ ...pen, tool: x.t })}>
          {x.label}
        </button>
      ))}
      {pen.tool !== 'eraser' &&
        pen.tool !== 'link' &&
        COLORS.map((c) => (
          <button class={`swatch ${pen.color === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => setPen({ ...pen, color: c })} />
        ))}
      {(pen.tool === 'pen' || pen.tool === 'highlighter') && (
        <select value={pen.width} onChange={(e) => setPen({ ...pen, width: Number((e.target as HTMLSelectElement).value) })}>
          <option value={0.0015}>Fin</option>
          <option value={0.003}>Moyen</option>
          <option value={0.006}>Épais</option>
        </select>
      )}
      {pen.tool === 'stamp' && (
        <select value={pen.stamp} onChange={(e) => setPen({ ...pen, stamp: (e.target as HTMLSelectElement).value })}>
          {STAMPS.map((s) => (
            <option value={s}>{s}</option>
          ))}
        </select>
      )}
      {pen.tool === 'link' && <span class="hint">Touchez l'endroit du renvoi sur la page.</span>}
      <button class="icon" title="Annuler" onClick={onUndo}>
        ↶
      </button>
      <button class="primary" onClick={onDone}>
        OK
      </button>
    </div>
  );
}

function PageView({
  page,
  setup,
  w,
  h,
  editing,
  cropping,
  pen,
  onSave,
  onLink,
  at,
  onAddLink,
  onRemoveLink,
  onCrop,
}: {
  page?: PageRef;
  setup?: PageSetup;
  w: number;
  h: number;
  editing: boolean;
  cropping: boolean;
  pen: Pen;
  onSave: (ref: PageRef, items: AnnItem[]) => void;
  onLink: (link: Link, at: number) => void;
  at: number;
  onAddLink: (ref: PageRef, x: number, y: number) => void;
  onRemoveLink: (ref: PageRef, link: Link) => void;
  onCrop: (crop: [number, number, number, number]) => void;
}) {
  const pdfCanvas = useRef<HTMLCanvasElement>(null);
  const annCanvas = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null); // in CSS pixels
  const rec = page ? store.get<PageAnnotations>(annId(page.song.id, page.index)) : undefined;
  const items = rec?.items ?? [];
  const song = page ? (store.get<Song>(page.song.id) ?? page.song) : undefined;
  const links = (song?.links ?? []).filter((l) => l.page === page?.index);
  const drawing = useRef<{ pts: number[]; id: number } | null>(null);
  const penSeen = useRef(false);
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  // While drawing a crop, show the whole (rotated) page.
  const shown: PageSetup | undefined = cropping ? { rot: setup?.rot } : setup;
  const key = JSON.stringify(shown ?? {});

  useEffect(() => {
    if (!page || !pdfCanvas.current) return;
    const dpr = window.devicePixelRatio || 1;
    let alive = true;
    const off = document.createElement('canvas');
    renderPage(page, off, w * dpr, h * dpr, loadBlob, shown).then((f) => {
      if (!alive || !pdfCanvas.current || !f) return;
      const c = pdfCanvas.current;
      c.width = off.width;
      c.height = off.height;
      c.getContext('2d')!.drawImage(off, 0, 0);
      setFrame(new Frame(shown, f.pw / dpr, f.ph / dpr));
    });
    return () => {
      alive = false;
    };
  }, [page?.file, page?.page, w, h, key]);

  useEffect(() => {
    const c = annCanvas.current;
    if (!c || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(frame.width * dpr);
    c.height = Math.round(frame.height * dpr);
    drawItems(c.getContext('2d')!, items, scaled(frame, dpr));
  }, [items, frame]);

  if (!page) return <div class="page" style={{ width: w, height: h }} />;

  const local = (e: PointerEvent): [number, number] => {
    const r = annCanvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const pos = (e: PointerEvent): [number, number] => frame!.unmap(...local(e));

  function down(e: PointerEvent) {
    if (!frame) return;
    if (cropping) {
      e.stopPropagation();
      annCanvas.current!.setPointerCapture(e.pointerId);
      const [x, y] = local(e);
      drawing.current = { pts: [x, y], id: e.pointerId };
      setBox([x, y, x, y]);
      return;
    }
    if (!editing) return;
    if (e.pointerType === 'pen') penSeen.current = true;
    else if (e.pointerType === 'touch' && penSeen.current) return; // palm rejection
    e.stopPropagation();
    const [x, y] = pos(e);
    if (pen.tool === 'link') return onAddLink(page!, x, y);
    if (pen.tool === 'text') {
      const text = prompt('Texte');
      if (text) onSave(page!, [...items, { t: 'text', color: pen.color, size: 0.018, x, y, text }]);
      return;
    }
    if (pen.tool === 'stamp') {
      onSave(page!, [...items, { t: 'stamp', color: pen.color, size: 0.03, x, y: y - 0.015, symbol: pen.stamp }]);
      return;
    }
    annCanvas.current!.setPointerCapture(e.pointerId);
    drawing.current = { pts: [x, y], id: e.pointerId };
    if (pen.tool === 'eraser') erase(x, y);
  }

  function move(e: PointerEvent) {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId || !frame) return;
    e.stopPropagation();
    if (cropping) {
      const [x, y] = local(e);
      setBox([d.pts[0], d.pts[1], x, y]);
      return;
    }
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const [x, y] = pos(ev);
      if (pen.tool === 'eraser') erase(x, y);
      else d.pts.push(x, y);
    }
    if (pen.tool !== 'eraser') {
      const c = annCanvas.current!;
      const f = scaled(frame, window.devicePixelRatio || 1);
      drawItems(c.getContext('2d')!, items, f);
      drawItem(c.getContext('2d')!, liveStroke(d.pts), f);
    }
  }

  function up(e: PointerEvent) {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId || !frame) return;
    drawing.current = null;
    if (cropping && box) {
      const [x0, y0, x1, y1] = box;
      setBox(null);
      if (Math.abs(x1 - x0) < 20 || Math.abs(y1 - y0) < 20) return;
      // Box in displayed pixels of the uncropped page → rotated page fractions.
      const fx = (x: number) => Math.max(0, Math.min(1, x / frame.width));
      const fy = (y: number) => Math.max(0, Math.min(1, y / frame.height));
      onCrop([fx(Math.min(x0, x1)), fy(Math.min(y0, y1)), fx(Math.max(x0, x1)), fy(Math.max(y0, y1))]);
      return;
    }
    if (pen.tool === 'pen' || pen.tool === 'highlighter') {
      onSave(page!, [...items, { ...liveStroke(simplify(d.pts)) }]);
    }
  }

  function liveStroke(pts: number[]): AnnItem {
    const hl = pen.tool === 'highlighter';
    return { t: 'stroke', color: pen.color, width: hl ? pen.width * 5 : pen.width, alpha: hl ? 0.35 : 1, pts };
  }

  function erase(x: number, y: number) {
    const aspect = frame!.ph / frame!.pw;
    const left = items.filter((it) => !hits(it, x, y, 0.01, aspect));
    if (left.length !== items.length) onSave(page!, left);
  }

  return (
    <div class="page" style={{ width: w, height: h }}>
      <div class="sheet" style={{ width: frame?.width, height: frame?.height }}>
        <canvas ref={pdfCanvas} style={{ width: frame?.width, height: frame?.height }} />
        <canvas
          ref={annCanvas}
          class={editing || cropping ? 'ann editing' : 'ann'}
          style={{ width: frame?.width, height: frame?.height }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        {box && (
          <div
            class="crop-box"
            style={{
              left: Math.min(box[0], box[2]),
              top: Math.min(box[1], box[3]),
              width: Math.abs(box[2] - box[0]),
              height: Math.abs(box[3] - box[1]),
            }}
          />
        )}
        {frame &&
          !cropping &&
          links.map((link) => {
            const [x, y] = frame.map(link.x, link.y);
            return (
              <button
                key={link.id}
                class="link-marker"
                style={{ left: x, top: y }}
                title={`${link.label} → page ${link.to + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (editing) {
                    if (confirm(`Supprimer le renvoi « ${link.label} » ?`)) onRemoveLink(page!, link);
                  } else onLink(link, at);
                }}
              >
                ↩ {link.label} <small>p.{link.to + 1}</small>
                {editing && <span class="del">✕</span>}
              </button>
            );
          })}
      </div>
    </div>
  );
}

// The same frame, in device pixels (canvas resolution).
function scaled(f: Frame, dpr: number) {
  return new Frame({ rot: f.rot, crop: f.crop }, f.pw * dpr, f.ph * dpr);
}
