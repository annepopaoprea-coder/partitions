// Unlock with the fingerprint (or face) via a passkey. The passkey's PRF
// extension gives a secret that only comes out after the biometric check;
// it seals this device's data key, so the fingerprint opens the encrypted
// library without typing the password. Nothing biometric leaves the device.

import { b64, unb64 } from './lock';
import type { Store } from './store';

interface BioKey {
  credId: string; // base64
  salt: string; // base64, PRF input
  box: ArrayBuffer; // data key sealed with the PRF-derived key
}

async function prfKey(prf: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('partitions-data-key') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out.buffer;
}

async function openBox(key: CryptoKey, box: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(box, 0, 12) }, key, new Uint8Array(box, 12));
}

// Can this device use a built-in fingerprint / face sensor?
export async function biometricAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export async function biometricEnrolled(store: Store): Promise<boolean> {
  return !!(await store.getMeta<BioKey>('bioKey'));
}

async function evaluate(credId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer | null> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const prf = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } })?.prf;
  return prf?.results?.first ?? null;
}

export type EnrollResult = 'ok' | 'unsupported' | 'cancelled';

// Register the fingerprint on this device (the library must be unlocked).
export async function enrollBiometric(store: Store, login: string): Promise<EnrollResult> {
  const raw = store.dataKey();
  if (!raw) return 'unsupported';
  const salt = crypto.getRandomValues(new Uint8Array(32));
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Partitions', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: login, displayName: `Partitions (${login})` },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch {
    return 'cancelled';
  }
  if (!cred) return 'cancelled';
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
  if (ext.prf?.enabled === false) return 'unsupported';
  const credId = new Uint8Array(cred.rawId);
  // Some devices only give the PRF secret when signing in: ask once more.
  let secret = ext.prf?.results?.first ?? null;
  if (!secret) {
    try {
      secret = await evaluate(credId, salt);
    } catch {
      return 'cancelled';
    }
  }
  if (!secret) return 'unsupported';
  const box = await seal(await prfKey(secret), raw);
  await store.setMeta('bioKey', { credId: b64(credId), salt: b64(salt), box } satisfies BioKey);
  return 'ok';
}

// Open the library with the fingerprint. False if cancelled or refused.
export async function unlockWithBiometric(store: Store): Promise<boolean> {
  const bio = await store.getMeta<BioKey>('bioKey');
  if (!bio) return false;
  try {
    const secret = await evaluate(unb64(bio.credId), unb64(bio.salt));
    if (!secret) return false;
    const raw = await openBox(await prfKey(secret), bio.box);
    return store.unsealRaw(raw);
  } catch {
    return false;
  }
}

export async function removeBiometric(store: Store) {
  await store.setMeta('bioKey', null);
}
