import { describe, expect, it } from 'vitest';
import { detectPitch, INSTRUMENTS, nearestNote, noteFreq, stringFreq, temperament } from '../src/tuner';

const near = (a: number[], b: number[], digits = 1) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('temperaments', () => {
  it('equal temperament has no deviation', () => {
    near(temperament('egal'), new Array(12).fill(0), 6);
  });

  it('Vallotti matches the published offsets (A = 0)', () => {
    //        C    C#   D    Eb   E     F    F#    G    G#   A  Bb   B
    near(temperament('vallotti'), [5.9, 0, 2.0, 3.9, -2.0, 7.8, -2.0, 3.9, 2.0, 0, 5.9, -3.9]);
  });

  it('Werckmeister III matches the published offsets, normalised to A', () => {
    const ref = [0, -9.8, -7.8, -5.9, -9.8, -2.0, -11.7, -3.9, -7.8, -11.7, -3.9, -7.8].map((c) => c + 11.7);
    // Published tables round each note before shifting to A, hence ±0.1 cent.
    temperament('werckmeister3').forEach((v, i) => expect(Math.abs(v - ref[i])).toBeLessThan(0.1));
  });

  it('quarter-comma meantone has pure major thirds C–E', () => {
    const t = temperament('mesotonique');
    const third = 400 + t[4] - t[0];
    expect(third).toBeCloseTo(1200 * Math.log2(5 / 4), 1);
  });
});

describe('notes and strings', () => {
  it('sets A4 to the diapason', () => {
    expect(noteFreq(69, 415, temperament('vallotti'))).toBeCloseTo(415, 6);
  });

  it('tunes violin strings in pure fifths', () => {
    const [g, d, a, e] = INSTRUMENTS[0].strings.map((s) => stringFreq(s, 415, temperament('egal')));
    expect(a).toBeCloseTo(415, 6);
    expect(e / a).toBeCloseTo(1.5, 6);
    expect(a / d).toBeCloseTo(1.5, 6);
    expect(d / g).toBeCloseTo(1.5, 6);
    expect(g).toBeCloseTo(184.4, 1);
  });

  it('names the nearest note and how far off it is', () => {
    const r = nearestNote(415 * 2 ** (10 / 1200), 415, temperament('egal'));
    expect(r.name).toBe('La');
    expect(r.octave).toBe(4);
    expect(r.cents).toBeCloseTo(10, 3);
  });
});

describe('pitch detection', () => {
  const sr = 48000;
  const tone = (hz: number, harmonics = 6) => {
    const b = new Float32Array(4096);
    for (let i = 0; i < b.length; i++)
      for (let h = 1; h <= harmonics; h++) b[i] += (0.5 / h) * Math.sin((2 * Math.PI * hz * h * i) / sr);
    return b;
  };

  for (const hz of [184.4, 293.3, 415, 622.5, 98]) {
    it(`finds ${hz} Hz in a rich (violin-like) tone within 2 cents`, () => {
      const f = detectPitch(tone(hz), sr)!;
      expect(Math.abs(1200 * Math.log2(f / hz))).toBeLessThan(2);
    });
  }

  it('ignores silence', () => {
    expect(detectPitch(new Float32Array(4096), sr)).toBeNull();
  });
});
