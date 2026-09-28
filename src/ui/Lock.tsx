import qrcode from 'qrcode-generator';
import { useEffect, useState } from 'preact/hooks';
import {
  checkPassword,
  createLock,
  deriveKek,
  lockoutMs,
  newRecoveryCodes,
  newSecret,
  otpauthUri,
  checkTotp,
  unbase32,
  unlock,
  type LockConfig,
} from '../lock';
import { biometricAvailable, biometricEnrolled, enrollBiometric, removeBiometric, unlockWithBiometric } from '../biometric';
import { LOCK_ID, type LockRec } from '../model';
import { drive, store, sync, useStore } from '../services';

// ---- Session state -------------------------------------------------------

const RELOCK_AFTER_MS = 60 * 60 * 1000; // hidden for 1 hour

// Unlocking lasts until the app is closed or reloaded: the key that opens the
// encrypted library only lives in memory.
let unlocked = false;
const unlockListeners = new Set<() => void>();

function setUnlocked(v: boolean) {
  unlocked = v;
  for (const fn of unlockListeners) fn();
}

// Locking forgets the data key too: a reload is the simplest way to drop it.
export function lockNow() {
  setUnlocked(false);
  if (store.encrypted) location.reload();
}

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS) lockNow();
});

export function lockConfig(): LockConfig | null {
  // While the library is sealed, records are not loaded: use the stored copy.
  if (store.sealed) return store.lockMirror;
  return store.get<LockRec>(LOCK_ID)?.config ?? null;
}

// True while the lock screen must be shown.
export function useLocked(): boolean {
  useStore();
  const [, set] = useState(0);
  useEffect(() => {
    const fn = () => set((n) => n + 1);
    unlockListeners.add(fn);
    return () => unlockListeners.delete(fn);
  }, []);
  return (!!lockConfig() && !unlocked) || store.sealed;
}

// Progress overlay shown while the library is being (de)crypted.
let showProgress: (text: string | null) => void = () => {};

export function CryptoProgress() {
  const [text, setText] = useState<string | null>(null);
  showProgress = setText;
  return text ? (
    <div class="busy-overlay">
      <div>{text}</div>
    </div>
  ) : null;
}

const progress = (label: string) => (done: number, total: number) =>
  showProgress(done >= total ? null : `${label} ${Math.round((100 * done) / total)} %`);

// Open (or, on first use, create) this device's encrypted library.
async function openLibrary(kek: CryptoKey): Promise<string | null> {
  let note: string | null = null;
  if (store.sealed && !(await store.unseal(kek))) {
    // The password was changed on another device: this copy cannot be opened
    // any more, so start afresh and download the library again from Drive.
    await store.wipe();
    note = 'Le mot de passe a été changé sur un autre appareil : la bibliothèque se télécharge à nouveau depuis Google Drive.';
  }
  if (!store.encrypted) {
    showProgress('Chiffrement des partitions sur cet appareil…');
    await store.encrypt(kek, progress('Chiffrement des partitions sur cet appareil…'));
    showProgress(null);
  }
  return note;
}

async function saveConfig(config: LockConfig | null) {
  await store.put({ id: LOCK_ID, kind: 'lock', config, updatedAt: 0, deviceId: '' });
  void sync.run();
}

// ---- Trusted device --------------------------------------------------------
// After one full login (password + code), this device only asks for the
// password for 30 days. Trust is tied to the current password (its salt).

const TRUST_DAYS = 30;

interface Trust {
  salt: string;
  until: number;
}

export async function trustedUntil(cfg: LockConfig | null): Promise<number | null> {
  const t = await store.getMeta<Trust>('trust');
  return cfg && t && t.salt === cfg.salt && t.until > Date.now() ? t.until : null;
}

async function trustDevice(cfg: LockConfig) {
  await store.setMeta('trust', { salt: cfg.salt, until: Date.now() + TRUST_DAYS * 86_400_000 } satisfies Trust);
}

export async function forgetTrust() {
  await store.setMeta('trust', null);
}

// ---- Lock screen ---------------------------------------------------------

function failures() {
  return Number(localStorage.getItem('lock.failures') ?? 0);
}

export function LockScreen() {
  const cfg = lockConfig()!;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [trusted, setTrusted] = useState<number | null | undefined>(undefined);
  const [remember, setRemember] = useState(true);
  useEffect(() => void trustedUntil(cfg).then(setTrusted), [cfg.salt]);
  const [bio, setBio] = useState(false);

  // Offer the fingerprint straight away when it is set up on this device.
  useEffect(() => {
    void biometricEnrolled(store).then((on) => {
      setBio(on);
      if (on) void withFingerprint();
    });
  }, []);

  async function withFingerprint() {
    setMsg('');
    if (await unlockWithBiometric(store)) {
      localStorage.setItem('lock.failures', '0');
      localStorage.removeItem('lock.until');
      setUnlocked(true);
      void sync.run();
    } else setMsg("Empreinte non reconnue ou annulée. Réessayez, ou entrez le mot de passe.");
  }
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [forgot, setForgot] = useState(false);

  // Countdown while guesses are throttled.
  useEffect(() => {
    const tick = () => {
      const until = Number(localStorage.getItem('lock.until') ?? 0);
      setWait(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    const until = Number(localStorage.getItem('lock.until') ?? 0);
    if (busy || until > Date.now()) {
      setWait(Math.ceil((until - Date.now()) / 1000));
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await unlock(cfg, cfg.login, password, trusted ? null : code);
      if (r.ok) {
        localStorage.setItem('lock.failures', '0');
        localStorage.removeItem('lock.until');
        if (!trusted && remember) await trustDevice(r.usedRecovery ?? cfg);
        const note = await openLibrary(r.kek);
        if (r.usedRecovery && lockConfig()) await saveConfig(r.usedRecovery);
        setUnlocked(true);
        if (note) alert(note);
        void sync.run();
        return;
      }
      const n = failures() + 1;
      localStorage.setItem('lock.failures', String(n));
      localStorage.setItem('lock.until', String(Date.now() + lockoutMs(n)));
      setWait(Math.ceil(lockoutMs(n) / 1000));
      setMsg(r.reason === 'code' ? 'Code incorrect.' : 'Mot de passe incorrect.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (forgot) return <ForgotPassword onCancel={() => setForgot(false)} />;

  return (
    <div class="lock-screen">
      <form class="lock-card" onSubmit={submit}>
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={64} height={64} />
        <h1>Partitions</h1>
        <input type="hidden" autocomplete="username" value={cfg.login} />
        {bio && (
          <>
            <button type="button" class="primary wide fingerprint" onClick={withFingerprint}>
              👆 Déverrouiller avec l'empreinte
            </button>
            <p class="hint or">ou avec le mot de passe :</p>
          </>
        )}
        <label>
          Mot de passe
          <input
            type="password"
            autocomplete="current-password"
            autoFocus
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {trusted === null && (
          <>
            <label>
              Code Google Authenticator
              <input
                inputMode="numeric"
                autocomplete="one-time-code"
                placeholder="123 456 (ou un code de secours)"
                value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                required
              />
            </label>
            <label class="check">
              <input type="checkbox" checked={remember} onChange={() => setRemember(!remember)} />
              Ne plus demander le code sur cet appareil pendant {TRUST_DAYS} jours
            </label>
          </>
        )}
        {trusted && <p class="hint">Appareil de confiance : pas de code jusqu'au {new Date(trusted).toLocaleDateString('fr')}.</p>}
        {msg && <p class="error">{msg}</p>}
        {wait > 0 && <p class="error">Trop d'essais. Réessayez dans {wait} s.</p>}
        <button class={bio ? 'wide' : 'primary wide'} disabled={busy || wait > 0 || trusted === undefined}>
          {busy ? 'Vérification…' : 'Entrer'}
        </button>
        <button type="button" class="link" onClick={() => setForgot(true)}>
          Mot de passe oublié ?
        </button>
      </form>
    </div>
  );
}

// Resetting the lock requires signing in to Google again (the Google account
// is protected by its own two-step verification).
function ForgotPassword({ onCancel }: { onCancel: () => void }) {
  const [msg, setMsg] = useState('');
  async function reset() {
    setMsg('');
    const ok = await drive.reauthenticate();
    if (!ok)
      return setMsg(
        "Réinitialisation refusée : il faut se connecter avec le compte Google qui contient cette bibliothèque (et que cet appareil l'ait déjà synchronisée).",
      );
    // The encrypted copy on this device cannot be opened without the old
    // password: forget it, the library comes back from Drive.
    if (store.sealed || store.encrypted) await store.wipe();
    await saveConfig(null);
    localStorage.setItem('lock.failures', '0');
    localStorage.removeItem('lock.until');
    setUnlocked(true);
    sessionStorage.setItem('lock.mustSetup', '1');
  }
  return (
    <div class="lock-screen">
      <div class="lock-card">
        <h1>Réinitialiser l'accès</h1>
        <p>
          Pour prouver que c'est bien vous, reconnectez-vous à votre compte Google (celui de votre Drive). Le verrou sera
          alors supprimé et vous pourrez en créer un nouveau.
        </p>
        <p class="hint">Si vous avez seulement perdu votre téléphone, utilisez plutôt un code de secours à la place du code.</p>
        <p class="hint">Les partitions chiffrées sur cet appareil seront retéléchargées depuis Google Drive.</p>
        {msg && <p class="error">{msg}</p>}
        <button class="primary wide" onClick={reset}>
          Se reconnecter à Google
        </button>
        <button class="link" onClick={onCancel}>
          Retour
        </button>
      </div>
    </div>
  );
}

// ---- Setup / change / remove (in Settings) --------------------------------

export function SecuritySection() {
  useStore();
  const cfg = lockConfig();
  const [mode, setMode] = useState<'none' | 'setup' | 'remove'>(
    sessionStorage.getItem('lock.mustSetup') === '1' ? 'setup' : 'none',
  );

  if (mode === 'setup') return <LockSetup existing={cfg} onDone={() => setMode('none')} />;
  if (mode === 'remove' && cfg) return <LockRemove cfg={cfg} onDone={() => setMode('none')} />;

  return (
    <section>
      <h2>Sécurité</h2>
      {cfg ? (
        <>
          <p>
            Accès protégé : identifiant <b>{cfg.login}</b>, mot de passe et Google Authenticator, sur tous vos appareils.
          </p>
          <TrustLine cfg={cfg} />
          <FingerprintLine login={cfg.login} />
          <p class="hint">
            {store.encrypted
              ? 'Les partitions et la bibliothèque sont chiffrées sur cet appareil.'
              : 'Chiffrement de cet appareil : à la prochaine ouverture.'}
          </p>
          <div class="row-buttons">
            <button onClick={lockNow}>Verrouiller maintenant</button>
            <button onClick={() => setMode('setup')}>Changer l'identifiant / le mot de passe</button>
            <button class="danger" onClick={() => setMode('remove')}>
              Désactiver
            </button>
          </div>
        </>
      ) : (
        <>
          <p>L'app n'est pas protégée. Ajoutez un identifiant, un mot de passe et un code Google Authenticator.</p>
          <button class="primary" onClick={() => setMode('setup')}>
            Protéger l'accès
          </button>
        </>
      )}
    </section>
  );
}

function LockSetup({ existing, onDone }: { existing: LockConfig | null; onDone: () => void }) {
  const [step, setStep] = useState<'current' | 'credentials' | 'qr' | 'recovery'>(existing ? 'current' : 'credentials');
  const [currentPw, setCurrentPw] = useState('');
  const [login, setLogin] = useState(existing?.login ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret] = useState(newSecret);
  const [recovery] = useState(() => newRecoveryCodes());

  async function checkCurrent() {
    setBusy(true);
    const ok = await checkPassword(existing!, currentPw);
    setBusy(false);
    if (ok) {
      setMsg('');
      setStep('credentials');
    } else setMsg('Mot de passe actuel incorrect.');
  }

  function checkCredentials() {
    if (login.trim().length < 3) return setMsg("L'identifiant doit faire au moins 3 caractères.");
    if (pw.length < 10) return setMsg('Le mot de passe doit faire au moins 10 caractères.');
    if (pw !== pw2) return setMsg('Les deux mots de passe ne sont pas identiques.');
    setMsg('');
    setStep('qr');
  }

  async function checkCode() {
    if (!(await checkTotp(unbase32(secret), code))) return setMsg('Code incorrect. Vérifiez que vous avez scanné ce QR code.');
    setMsg('');
    setStep('recovery');
  }

  async function finish() {
    setBusy(true);
    const cfg = await createLock(login, pw, secret, recovery);
    await saveConfig(cfg);
    await trustDevice(cfg); // the code was just checked on this device
    // Encrypt this device's library, or reseal its key under the new password.
    const kek = await deriveKek(cfg, pw);
    if (store.encrypted) await store.rewrap(kek);
    else {
      showProgress('Chiffrement des partitions sur cet appareil…');
      await store.encrypt(kek, progress('Chiffrement des partitions sur cet appareil…'));
      showProgress(null);
    }
    sessionStorage.removeItem('lock.mustSetup');
    setUnlocked(true);
    setBusy(false);
    onDone();
  }

  const qr = qrcode(0, 'M');
  qr.addData(otpauthUri(login.trim().toLowerCase(), secret));
  qr.make();

  return (
    <section class="lock-setup">
      <h2>{existing ? 'Modifier la protection' : "Protéger l'accès"}</h2>

      {step === 'current' && (
        <>
          <label>
            Mot de passe actuel
            <input type="password" value={currentPw} onInput={(e) => setCurrentPw((e.target as HTMLInputElement).value)} />
          </label>
          <button class="primary" disabled={busy} onClick={checkCurrent}>
            Continuer
          </button>
        </>
      )}

      {step === 'credentials' && (
        <>
          <p class="hint">Étape 1 sur 3 : choisissez vos identifiants.</p>
          <label>
            Identifiant
            <input autocomplete="username" value={login} onInput={(e) => setLogin((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            Mot de passe (10 caractères minimum)
            <input type="password" autocomplete="new-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            Confirmer le mot de passe
            <input type="password" autocomplete="new-password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
          </label>
          <button class="primary" onClick={checkCredentials}>
            Continuer
          </button>
        </>
      )}

      {step === 'qr' && (
        <>
          <p class="hint">Étape 2 sur 3 : dans Google Authenticator, touchez « + » puis « Scanner un code QR ».</p>
          <div class="qr" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }) }} />
          <p class="hint">
            Impossible de scanner ? Choisissez « Saisir une clé de configuration » et tapez : <code>{secret.match(/.{1,4}/g)!.join(' ')}</code>
          </p>
          <label>
            Code affiché dans Google Authenticator
            <input inputMode="numeric" autocomplete="one-time-code" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
          </label>
          <button class="primary" onClick={checkCode}>
            Vérifier
          </button>
        </>
      )}

      {step === 'recovery' && (
        <>
          <p class="hint">
            Étape 3 sur 3 : notez ces codes de secours et gardez-les en lieu sûr (papier, gestionnaire de mots de passe). Chacun
            remplace une fois le code Authenticator si vous perdez votre téléphone.
          </p>
          <ul class="recovery">
            {recovery.map((c) => (
              <li>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <button class="primary" disabled={busy} onClick={finish}>
            {busy ? 'Enregistrement…' : "J'ai noté mes codes, activer la protection"}
          </button>
        </>
      )}

      {msg && <p class="error">{msg}</p>}
      <button class="link" onClick={onDone}>
        Annuler
      </button>
    </section>
  );
}

function LockRemove({ cfg, onDone }: { cfg: LockConfig; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  async function remove() {
    const r = await unlock(cfg, cfg.login, pw, code);
    if (!r.ok) return setMsg('Mot de passe ou code incorrect.');
    showProgress('Déchiffrement des partitions…');
    await store.decrypt(progress('Déchiffrement des partitions…'));
    showProgress(null);
    await saveConfig(null);
    onDone();
  }
  return (
    <section>
      <h2>Désactiver la protection</h2>
      <label>
        Mot de passe
        <input type="password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Code Google Authenticator
        <input inputMode="numeric" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
      </label>
      {msg && <p class="error">{msg}</p>}
      <button class="danger" onClick={remove}>
        Désactiver
      </button>
      <button class="link" onClick={onDone}>
        Annuler
      </button>
    </section>
  );
}

function TrustLine({ cfg }: { cfg: LockConfig }) {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => void trustedUntil(cfg).then(setUntil), [cfg.salt]);
  if (!until) return <p class="hint">Cet appareil demande le code Google Authenticator à chaque ouverture.</p>;
  return (
    <p class="hint">
      Appareil de confiance : seul le mot de passe est demandé jusqu'au {new Date(until).toLocaleDateString('fr')}.{' '}
      <button class="link" onClick={() => forgetTrust().then(() => setUntil(null))}>
        Redemander le code
      </button>
    </p>
  );
}

function FingerprintLine({ login }: { login: string }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    void biometricAvailable().then(setAvailable);
    void biometricEnrolled(store).then(setOn);
  }, []);
  if (available === null) return null;
  if (!available)
    return <p class="hint">Empreinte digitale : ce navigateur n'a pas accès à un capteur d'empreinte sur cet appareil.</p>;
  async function enable() {
    setMsg('');
    const r = await enrollBiometric(store, login);
    if (r === 'ok') setOn(true);
    else if (r === 'unsupported')
      setMsg("Cet appareil ne permet pas d'ouvrir les partitions chiffrées avec l'empreinte. Le mot de passe reste nécessaire.");
    else setMsg('Activation annulée.');
  }
  return (
    <div class="fingerprint-line">
      {on ? (
        <p class="hint">
          👆 Empreinte digitale activée sur cet appareil.{' '}
          <button class="link" onClick={() => removeBiometric(store).then(() => setOn(false))}>
            Désactiver
          </button>
        </p>
      ) : (
        <button onClick={enable} disabled={!store.encrypted}>
          👆 Se connecter avec l'empreinte digitale sur cet appareil
        </button>
      )}
      {msg && <p class="error">{msg}</p>}
    </div>
  );
}
