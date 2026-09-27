// Tuner maths: historical pitch standards, temperaments built from their
// circle of fifths, and pitch detection (YIN).

export const DIAPASONS: { hz: number; label: string }[] = [
  { hz: 392, label: '392 Hz — ton d’opéra français, diapason romain' },
  { hz: 415, label: '415 Hz — diapason baroque (convention actuelle)' },
  { hz: 430, label: '430 Hz — classique (après 1730, Mozart)' },
  { hz: 440, label: '440 Hz — diapason moderne' },
  { hz: 442, label: '442 Hz — orchestres actuels' },
  { hz: 465, label: '465 Hz — Chorton, ton de chapelle vénitien' },
];

const PURE_FIFTH = 1200 * Math.log2(3 / 2); // 701.955 cents
const PYTH = 1200 * Math.log2(531441 / 524288); // Pythagorean comma, 23.460
const SYNT = 1200 * Math.log2(81 / 80); // syntonic comma, 21.506
const SCHISMA = PYTH - SYNT;

// Fifths around the circle, named by their lower note, from Eb up to G#.
const CIRCLE = ['Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#'] as const;
type Fifth = (typeof CIRCLE)[number];
const SEMITONE: Record<Fifth, number> = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, Bb: 10, B: 11 };

// How much each fifth (lower note → the fifth above) is narrowed, in cents.
// Fifths not listed are pure; the leftover lands on G#–Eb.
const TEMPERED: Record<string, { label: string; narrow: Partial<Record<Fifth, number>> }> = {
  egal: { label: 'Égal', narrow: Object.fromEntries(CIRCLE.map((n) => [n, PYTH / 12])) },
  werckmeister3: {
    label: 'Werckmeister III (1691)',
    narrow: { C: PYTH / 4, G: PYTH / 4, D: PYTH / 4, B: PYTH / 4 },
  },
  vallotti: {
    label: 'Vallotti',
    narrow: { F: PYTH / 6, C: PYTH / 6, G: PYTH / 6, D: PYTH / 6, A: PYTH / 6, E: PYTH / 6 },
  },
  young: {
    label: 'Young (1799)',
    narrow: { C: PYTH / 6, G: PYTH / 6, D: PYTH / 6, A: PYTH / 6, E: PYTH / 6, B: PYTH / 6 },
  },
  kirnberger3: {
    label: 'Kirnberger III',
    narrow: { C: SYNT / 4, G: SYNT / 4, D: SYNT / 4, A: SYNT / 4, 'F#': SCHISMA },
  },
  mesotonique: {
    label: 'Mésotonique ¼ de comma',
    narrow: Object.fromEntries(CIRCLE.slice(0, 11).map((n) => [n, SYNT / 4])),
  },
};

export const TEMPERAMENTS = Object.entries(TEMPERED).map(([id, t]) => ({ id, label: t.label }));

// Deviation from equal temperament for each pitch class (C = 0 … B = 11),
// in cents, with A at 0 so the diapason sets A exactly.
export function temperament(id: string): number[] {
  const t = TEMPERED[id] ?? TEMPERED.egal;
  const cents: Partial<Record<Fifth, number>> = { C: 0 };
  const iC = CIRCLE.indexOf('C');
  for (let i = iC; i < CIRCLE.length - 1; i++) {
    const low = CIRCLE[i];
    cents[CIRCLE[i + 1]] = cents[low]! + PURE_FIFTH - (t.narrow[low] ?? 0);
  }
  for (let i = iC - 1; i >= 0; i--) {
    const low = CIRCLE[i];
    cents[low] = cents[CIRCLE[i + 1]]! - (PURE_FIFTH - (t.narrow[low] ?? 0));
  }
  const dev = new Array<number>(12);
  for (const n of CIRCLE) {
    const pc = SEMITONE[n];
    const c = (((cents[n]! % 1200) + 1200) % 1200);
    let d = c - pc * 100;
    if (d > 600) d -= 1200;
    if (d < -600) d += 1200;
    dev[pc] = d;
  }
  const a = dev[9];
  return dev.map((d) => d - a);
}

export const NOTE_NAMES = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'Si♭', 'Si'];

// Frequency of a MIDI note under a diapason (A4) and temperament.
export function noteFreq(midi: number, a4: number, dev: number[]): number {
  return a4 * 2 ** ((midi - 69 + dev[((midi % 12) + 12) % 12] / 100) / 12);
}

export interface Reading {
  midi: number;
  name: string;
  octave: number;
  cents: number; // how far the played pitch is from the target
  target: number;
}

export function nearestNote(freq: number, a4: number, dev: number[]): Reading {
  const approx = Math.round(69 + 12 * Math.log2(freq / a4));
  let best: Reading | null = null;
  for (const midi of [approx - 1, approx, approx + 1]) {
    const target = noteFreq(midi, a4, dev);
    const cents = 1200 * Math.log2(freq / target);
    if (!best || Math.abs(cents) < Math.abs(best.cents)) {
      best = { midi, name: NOTE_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents, target };
    }
  }
  return best!;
}

// Open strings. Violin-family strings are tuned in pure fifths from A.
// Strings given as pure fifths from the instrument's A (A4, or A3 for cello),
// or as a note number for fretted viols tuned to the temperament.
interface OpenString {
  name: string;
  fifthsFromA?: number;
  aBelow?: boolean; // measured from A3 instead of A4
  midi?: number;
}

export const INSTRUMENTS: { id: string; label: string; strings: OpenString[] }[] = [
  { id: 'violon', label: 'Violon', strings: [{ name: 'Sol', fifthsFromA: -2 }, { name: 'Ré', fifthsFromA: -1 }, { name: 'La', fifthsFromA: 0 }, { name: 'Mi', fifthsFromA: 1 }] },
  { id: 'alto', label: 'Alto', strings: [{ name: 'Do', fifthsFromA: -3 }, { name: 'Sol', fifthsFromA: -2 }, { name: 'Ré', fifthsFromA: -1 }, { name: 'La', fifthsFromA: 0 }] },
  { id: 'violoncelle', label: 'Violoncelle', strings: [{ name: 'Do', fifthsFromA: -3, aBelow: true }, { name: 'Sol', fifthsFromA: -2, aBelow: true }, { name: 'Ré', fifthsFromA: -1, aBelow: true }, { name: 'La', fifthsFromA: 0, aBelow: true }] },
  { id: 'gambe', label: 'Viole de gambe basse', strings: [{ name: 'Ré', midi: 38 }, { name: 'Sol', midi: 43 }, { name: 'Do', midi: 48 }, { name: 'Mi', midi: 52 }, { name: 'La', midi: 57 }, { name: 'Ré', midi: 62 }] },
];

export function stringFreq(s: OpenString, a4: number, dev: number[]): number {
  if (s.midi !== undefined) return noteFreq(s.midi, a4, dev);
  return (s.aBelow ? a4 / 2 : a4) * (3 / 2) ** s.fifthsFromA!;
}

// YIN pitch detection. Returns the fundamental in Hz, or null when there is
// no clear pitch (silence, noise).
export function detectPitch(buf: Float32Array, sampleRate: number, minHz = 55, maxHz = 1800): number | null {
  let rms = 0;
  for (const v of buf) rms += v * v;
  if (Math.sqrt(rms / buf.length) < 0.01) return null;
  const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(buf.length / 2));
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  const d = new Float32Array(maxTau + 1);
  const n = buf.length - maxTau;
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const diff = buf[i] - buf[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // Cumulative mean normalized difference.
  let running = 0;
  d[0] = 1;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    d[tau] = running ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (d[t] < 0.12) {
      while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // Parabolic interpolation around the minimum.
  const a = d[tau - 1] ?? d[tau];
  const b = d[tau];
  const c = d[tau + 1] ?? d[tau];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return sampleRate / (tau + (Number.isFinite(shift) ? shift : 0));
}
