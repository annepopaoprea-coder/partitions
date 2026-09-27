import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { back, go } from '../app';
import { annId, type AnnItem, type PageAnnotations, type Song, type Tool } from '../model';
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

export function Reader({ songIds, start = 0, title }: { songIds: string[]; start?: number; title?: string }) {
  useStore();
  const [pages, setPages] = useState<PageRef[] | null>(null);
  const [firstOf, setFirstOf] = useState<number[]>([]);
  const [idx, setIdx] = useState(0);
  const [half, setHalf] = useState(false);
  const [bar, setBar] = useState(true);
  const [editing, setEditing] = useState(false);
  const [halfMode, setHalfMode] = useState(prefs.halfPage);
  const [twoUpPref, setTwoUpPref] = useState(prefs.twoUp);
  const [pen, setPen] = useState<Pen>({ tool: 'pen', color: COLORS[0], width: 0.003, stamp: 'p' });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState('');
  const undo = useRef<Undo[]>([]);
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

  const count = pages?.length ?? 0;
  const twoUp = twoUpPref && size.w > size.h * 1.15 && !editing;
  const step = twoUp ? 2 : 1;

  const next = () => {
    if (halfMode && !twoUp && !half && idx + 1 < count) return setHalf(true);
    setHalf(false);
    setIdx((i) => Math.min(i + (half ? 1 : step), Math.max(0, count - 1)));
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
    if (editing) return;
    const x = e.clientX / window.innerWidth;
    if (x < 0.3) prev();
    else if (x > 0.7) next();
    else setBar((b) => !b);
  }

  async function saveAnn(ref: PageRef, items: AnnItem[]) {
    const id = annId(ref.song.id, ref.index);
    const prevRec = store.get<PageAnnotations>(id);
    undo.current.push({ id, song: ref.song, index: ref.index, items: prevRec?.items ?? [] });
    await store.put({
      id,
      kind: 'ann',
      songId: ref.song.id,
      page: ref.index,
      items,
      updatedAt: 0,
      deviceId: '',
    });
  }

  async function doUndo() {
    const u = undo.current.pop();
    if (!u) return;
    await store.put({ id: u.id, kind: 'ann', songId: u.song.id, page: u.index, items: u.items, updatedAt: 0, deviceId: '' });
  }

  const current = pages?.[idx];
  const songIndex = current ? firstOf.findLastIndex((f) => f <= idx) : -1;
  const slotW = twoUp ? size.w / 2 : size.w;

  return (
    <div class="reader">
      <div class="pages" ref={box} onClick={onTap}>
        {pages && size.w > 0 && current && (
          half ? (
            <div class="half">
              <div class="half-top" style={{ height: size.h / 2 }}>
                <PageView page={pages[idx + 1]} w={size.w} h={size.h} editing={false} pen={pen} onSave={saveAnn} />
              </div>
              <div class="half-bottom" style={{ height: size.h / 2 }}>
                <div style={{ marginTop: -size.h / 2 }}>
                  <PageView page={current} w={size.w} h={size.h} editing={false} pen={pen} onSave={saveAnn} />
                </div>
              </div>
            </div>
          ) : (
            <>
              <PageView page={current} w={slotW} h={size.h} editing={editing} pen={pen} onSave={saveAnn} />
              {twoUp && pages[idx + 1] && (
                <PageView page={pages[idx + 1]} w={slotW} h={size.h} editing={false} pen={pen} onSave={saveAnn} />
              )}
            </>
          )
        )}
        {pages && !count && <p class="empty">{error || 'Aucune page à afficher.'}</p>}
        {!pages && <p class="empty">Chargement…</p>}
      </div>

      {(bar || editing) && (
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
          {!editing ? (
            <>
              <button class="icon" title="Annoter" onClick={() => setEditing(true)}>
                ✎
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
                title="Plein écran"
                onClick={() =>
                  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
                }
              >
                ⛶
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

      {!editing && count > 0 && (
        <input
          class="page-slider"
          type="range"
          min={0}
          max={count - 1}
          value={idx}
          style={{ visibility: bar ? 'visible' : 'hidden' }}
          onInput={(e) => {
            setHalf(false);
            setIdx(Number((e.target as HTMLInputElement).value));
          }}
        />
      )}
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
  ];
  return (
    <div class="tools">
      {tools.map((x) => (
        <button class={`icon ${pen.tool === x.t ? 'on' : ''}`} title={x.title} onClick={() => setPen({ ...pen, tool: x.t })}>
          {x.label}
        </button>
      ))}
      {pen.tool !== 'eraser' &&
        COLORS.map((c) => (
          <button
            class={`swatch ${pen.color === c ? 'on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => setPen({ ...pen, color: c })}
          />
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
  w,
  h,
  editing,
  pen,
  onSave,
}: {
  page?: PageRef;
  w: number;
  h: number;
  editing: boolean;
  pen: Pen;
  onSave: (ref: PageRef, items: AnnItem[]) => void;
}) {
  const pdfCanvas = useRef<HTMLCanvasElement>(null);
  const annCanvas = useRef<HTMLCanvasElement>(null);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  const rec = page ? store.get<PageAnnotations>(annId(page.song.id, page.index)) : undefined;
  const items = rec?.items ?? [];
  const drawing = useRef<{ pts: number[]; id: number } | null>(null);
  const penSeen = useRef(false);

  useEffect(() => {
    if (!page || !pdfCanvas.current) return;
    const dpr = window.devicePixelRatio || 1;
    let alive = true;
    const off = document.createElement('canvas');
    renderPage(page, off, w * dpr, h * dpr, loadBlob).then(() => {
      if (!alive || !pdfCanvas.current) return;
      const c = pdfCanvas.current;
      c.width = off.width;
      c.height = off.height;
      c.getContext('2d')!.drawImage(off, 0, 0);
      setDim({ w: off.width / dpr, h: off.height / dpr });
    });
    return () => {
      alive = false;
    };
  }, [page?.file, page?.page, w, h]);

  useEffect(() => {
    const c = annCanvas.current;
    if (!c || !dim.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = dim.w * dpr;
    c.height = dim.h * dpr;
    drawItems(c.getContext('2d')!, items, c.width, c.height);
  }, [items, dim]);

  if (!page) return <div class="page" style={{ width: w, height: h }} />;

  const pos = (e: PointerEvent) => {
    const r = annCanvas.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  function down(e: PointerEvent) {
    if (!editing) return;
    if (e.pointerType === 'pen') penSeen.current = true;
    else if (e.pointerType === 'touch' && penSeen.current) return; // palm rejection
    e.stopPropagation();
    const [x, y] = pos(e);
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
    if (!d || d.id !== e.pointerId) return;
    e.stopPropagation();
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const [x, y] = pos(ev);
      if (pen.tool === 'eraser') erase(x, y);
      else d.pts.push(x, y);
    }
    if (pen.tool !== 'eraser') {
      const c = annCanvas.current!;
      drawItems(c.getContext('2d')!, items, c.width, c.height);
      drawItem(c.getContext('2d')!, liveStroke(d.pts), c.width, c.height);
    }
  }

  function up(e: PointerEvent) {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    drawing.current = null;
    if (pen.tool === 'pen' || pen.tool === 'highlighter') {
      onSave(page!, [...items, { ...liveStroke(simplify(d.pts)) }]);
    }
  }

  function liveStroke(pts: number[]): AnnItem {
    const hl = pen.tool === 'highlighter';
    return { t: 'stroke', color: pen.color, width: hl ? pen.width * 5 : pen.width, alpha: hl ? 0.35 : 1, pts };
  }

  function erase(x: number, y: number) {
    const aspect = dim.h / dim.w;
    const left = items.filter((it) => !hits(it, x, y, 0.01, aspect));
    if (left.length !== items.length) onSave(page!, left);
  }

  return (
    <div class="page" style={{ width: w, height: h }}>
      <div class="sheet" style={{ width: dim.w || undefined, height: dim.h || undefined }}>
        <canvas ref={pdfCanvas} style={{ width: dim.w, height: dim.h }} />
        <canvas
          ref={annCanvas}
          class={editing ? 'ann editing' : 'ann'}
          style={{ width: dim.w, height: dim.h }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>
    </div>
  );
}
