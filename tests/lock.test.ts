import { describe, expect, it } from 'vitest';
import { base32, checkTotp, createLock, lockoutMs, totp, unbase32, unlock } from '../src/lock';

const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 test vectors', async () => {
    expect(await totp(RFC_SECRET, 59_000, 8)).toBe('94287082');
    expect(await totp(RFC_SECRET, 1111111109_000, 8)).toBe('07081804');
    expect(await totp(RFC_SECRET, 20000000000_000, 8)).toBe('65353130');
  });

  it('round-trips base32', () => {
    const s = base32(RFC_SECRET);
    expect(s).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect([...unbase32(s)]).toEqual([...RFC_SECRET]);
  });

  it('accepts one step of clock drift but not more', async () => {
    const t = 1_700_000_000_000;
    const code = await totp(RFC_SECRET, t);
    expect(await checkTotp(RFC_SECRET, code, t + 30_000)).toBe(true);
    expect(await checkTotp(RFC_SECRET, code, t + 95_000)).toBe(false);
  });
});

describe('lock', () => {
  const secret = base32(RFC_SECRET);
  const make = () => createLock('Anne', 'mot de passe solide', secret, ['aaaa-bbbb', 'cccc-dddd'], 1000);

  it('never stores the password or the secret in clear', async () => {
    const cfg = await make();
    const text = JSON.stringify(cfg);
    expect(text).not.toContain('mot de passe');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('aaaa-bbbb');
  });

  it('unlocks with login, password and current code', async () => {
    const cfg = await make();
    const code = await totp(RFC_SECRET);
    expect(await unlock(cfg, 'anne', 'mot de passe solide', code)).toMatchObject({ ok: true });
  });

  it('rejects a wrong password or login', async () => {
    const cfg = await make();
    const code = await totp(RFC_SECRET);
    expect(await unlock(cfg, 'anne', 'mauvais', code)).toEqual({ ok: false, reason: 'credentials' });
    expect(await unlock(cfg, 'autre', 'mot de passe solide', code)).toEqual({ ok: false, reason: 'credentials' });
  });

  it('accepts the password alone on a trusted device', async () => {
    const cfg = await make();
    expect(await unlock(cfg, 'anne', 'mot de passe solide', null)).toMatchObject({ ok: true });
    expect(await unlock(cfg, 'anne', 'mauvais', null)).toEqual({ ok: false, reason: 'credentials' });
  });

  it('rejects a wrong code', async () => {
    const cfg = await make();
    expect(await unlock(cfg, 'anne', 'mot de passe solide', '000000')).toMatchObject({ ok: false, reason: 'code' });
  });

  it('accepts each recovery code once', async () => {
    const cfg = await make();
    const r = await unlock(cfg, 'anne', 'mot de passe solide', 'aaaa-bbbb');
    expect(r.ok && r.usedRecovery).toBeTruthy();
    const next = (r as { usedRecovery: typeof cfg }).usedRecovery;
    expect(await unlock(next, 'anne', 'mot de passe solide', 'aaaa-bbbb')).toMatchObject({ ok: false });
    expect(await unlock(next, 'anne', 'mot de passe solide', 'cccc-dddd')).toMatchObject({ ok: true });
  });

  it('throttles repeated failures', () => {
    expect(lockoutMs(2)).toBe(0);
    expect(lockoutMs(3)).toBe(30_000);
    expect(lockoutMs(5)).toBe(120_000);
    expect(lockoutMs(30)).toBe(3_600_000);
  });
});
