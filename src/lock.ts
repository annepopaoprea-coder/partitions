// App lock: login + password + authenticator code (TOTP, RFC 6238).
//
// Nothing secret is stored in clear: the password is kept only as a PBKDF2
// hash, and the authenticator secret and recovery codes are encrypted with a
// key derived from the password. The lock settings sync through Drive like
// any record, so every device shares one authenticator entry.

export interface LockConfig {
  login: string;
  salt: string; // base64
  iterations: number;
  passwordHash: string; // base64, PBKDF2 bits used to check the password
  secretBox: string; // base64 AES-GCM(iv + ciphertext) of the TOTP secret (base32)
  recoveryBox: string; // same for the JSON list of unused recovery codes
}

const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totp(secret: Uint8Array<ArrayBuffer>, time = Date.now(), digits = 6, step = 30): Promise<string> {
  const counter = Math.floor(time / 1000 / step);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

// Accept the previous, current and next 30-second codes (clock drift).
export async function checkTotp(secret: Uint8Array<ArrayBuffer>, code: string, time = Date.now()): Promise<boolean> {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  for (const d of [-1, 0, 1]) if ((await totp(secret, time + d * 30_000)) === c) return true;
  return false;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  // 512 bits: first half checks the password, second half is the AES key.
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 512));
  const aes = await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { check: bits.slice(0, 32), aes };
}

async function seal(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

async function open(key: CryptoKey, box: string): Promise<string> {
  const data = unb64(box);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12)));
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function newSecret(): string {
  return base32(crypto.getRandomValues(new Uint8Array(20)));
}

export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const b = crypto.getRandomValues(new Uint8Array(5));
    const s = base32(b).slice(0, 8).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export function otpauthUri(login: string, secret: string) {
  const label = encodeURIComponent(`Partitions:${login}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Partitions&algorithm=SHA1&digits=6&period=30`;
}

export async function createLock(
  login: string,
  password: string,
  secret: string,
  recovery: string[],
  iterations = ITERATIONS,
): Promise<LockConfig> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { check, aes } = await derive(password, salt, iterations);
  return {
    login: login.trim().toLowerCase(),
    salt: b64(salt),
    iterations,
    passwordHash: b64(check),
    secretBox: await seal(aes, secret),
    recoveryBox: await seal(aes, JSON.stringify(recovery)),
  };
}

export type UnlockResult =
  // kek opens this device's encrypted data; usedRecovery is the updated
  // config when a recovery code was spent.
  | { ok: true; kek: CryptoKey; usedRecovery?: LockConfig }
  | { ok: false; reason: 'credentials' | 'code' };

// Check login + password, then the authenticator code or a recovery code.
export async function unlock(cfg: LockConfig, login: string, password: string, code: string): Promise<UnlockResult> {
  const { check, aes } = await derive(password, unb64(cfg.salt), cfg.iterations);
  const loginOk = login.trim().toLowerCase() === cfg.login;
  if (!sameBytes(check, unb64(cfg.passwordHash)) || !loginOk) return { ok: false, reason: 'credentials' };
  const secret = unbase32(await open(aes, cfg.secretBox));
  if (await checkTotp(secret, code)) return { ok: true, kek: aes };
  const rc = code.trim().toLowerCase();
  const codes: string[] = JSON.parse(await open(aes, cfg.recoveryBox));
  if (codes.includes(rc)) {
    const left = codes.filter((c) => c !== rc);
    return { ok: true, kek: aes, usedRecovery: { ...cfg, recoveryBox: await seal(aes, JSON.stringify(left)) } };
  }
  return { ok: false, reason: 'code' };
}

// Key that opens this device's encrypted data, derived from the password.
export async function deriveKek(cfg: LockConfig, password: string): Promise<CryptoKey> {
  return (await derive(password, unb64(cfg.salt), cfg.iterations)).aes;
}

// Only checks the password (used before changing lock settings).
export async function checkPassword(cfg: LockConfig, password: string): Promise<boolean> {
  const { check } = await derive(password, unb64(cfg.salt), cfg.iterations);
  return sameBytes(check, unb64(cfg.passwordHash));
}

// Throttle guesses: after 3 failures, wait 30 s, doubling each time (max 1 h).
export function lockoutMs(failures: number): number {
  if (failures < 3) return 0;
  return Math.min(30_000 * 2 ** (failures - 3), 3_600_000);
}
