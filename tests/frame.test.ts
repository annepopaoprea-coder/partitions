import { describe, expect, it } from 'vitest';
import { Frame, type Rotation } from '../src/frame';

describe('frame', () => {
  const rots: Rotation[] = [0, 90, 180, 270];

  it('maps and unmaps back to the same page point, for every rotation and crop', () => {
    for (const rot of rots) {
      const f = new Frame({ rot, crop: [0.1, 0.05, 0.9, 0.8] }, 600, 800);
      for (const [u, v] of [[0.2, 0.3], [0.5, 0.5], [0.85, 0.1]]) {
        const [x, y] = f.map(u, v);
        const [u2, v2] = f.unmap(x, y);
        expect(u2).toBeCloseTo(u, 9);
        expect(v2).toBeCloseTo(v, 9);
      }
    }
  });

  it('turns a portrait page into landscape at 90°', () => {
    const f = new Frame({ rot: 90 }, 600, 800);
    expect([f.width, f.height]).toEqual([800, 600]);
    // Top-left of the original ends up at the top-right once turned clockwise.
    expect(f.map(0, 0)).toEqual([800, 0]);
  });

  it('crops to the chosen box', () => {
    const f = new Frame({ crop: [0.1, 0.1, 0.6, 0.5] }, 1000, 1000);
    expect([f.width, f.height]).toEqual([500, 400]);
    expect(f.map(0.1, 0.1)).toEqual([0, 0]);
  });
});
