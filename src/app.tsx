import { useEffect, useState } from 'preact/hooks';
import { drive, sync, useSignedIn, useSync } from './services';
import { Library } from './ui/Library';
import { LockScreen, useLocked } from './ui/Lock';
import { Reader } from './ui/Reader';
import { SetlistView } from './ui/Setlists';
import { Settings } from './ui/Settings';
import { Trash } from './ui/Trash';
import { Tuner } from './ui/Tuner';
import { SongEditor } from './ui/SongEditor';

export type View =
  | { name: 'library' }
  | { name: 'reader'; songIds: string[]; start?: number; title?: string }
  | { name: 'song'; id: string }
  | { name: 'setlist'; id: string }
  | { name: 'settings' }
  | { name: 'trash' }
  | { name: 'tuner' };

// Views stack like app screens; the Android back button pops them.
let stack: View[] = [{ name: 'library' }];
let setTop: (v: View) => void = () => {};

export function go(v: View) {
  stack.push(v);
  history.pushState(stack.length, '');
  setTop(v);
}

export function back() {
  history.back();
}

// While set (concert mode), the back gesture is ignored.
let backGuard: (() => boolean) | null = null;

export function setBackGuard(fn: (() => boolean) | null) {
  backGuard = fn;
}

window.addEventListener('popstate', () => {
  if (backGuard?.()) {
    history.pushState(stack.length, '');
    return;
  }
  if (stack.length > 1) stack.pop();
  setTop(stack[stack.length - 1]);
});

let applyUpdate: (() => void) | null = null;
let showUpdate: (fn: (() => void) | null) => void = () => {};

export function setUpdate(fn: () => void) {
  applyUpdate = fn;
  showUpdate(fn);
}

function UpdateBanner() {
  const [fn, setFn] = useState(applyUpdate);
  showUpdate = setFn;
  if (!fn) return null;
  return (
    <div class="update-banner">
      Nouvelle version disponible
      <button class="primary" onClick={fn}>
        Mettre à jour
      </button>
      <button class="icon" title="Plus tard" onClick={() => setFn(null)}>
        ✕
      </button>
    </div>
  );
}

export function App() {
  return (
    <>
      <Screens />
      <UpdateBanner />
    </>
  );
}

function Screens() {
  const [view, setView] = useState<View>(stack[stack.length - 1]);
  setTop = setView;
  const signedIn = useSignedIn();

  // A returning user whose Google session expired is reconnected on the
  // next tap anywhere: browsers only allow the Google window from a gesture.
  useEffect(() => {
    drive.preload();
    const onTap = () => {
      if (!drive.signedIn && drive.knownUser) {
        void drive.signIn().then((ok) => {
          if (ok) void sync.run();
        });
      }
    };
    window.addEventListener('pointerup', onTap, true);
    return () => window.removeEventListener('pointerup', onTap, true);
  }, []);

  useEffect(() => {
    if (signedIn) void sync.run();
  }, [signedIn]);

  if (useLocked()) return <LockScreen />;

  switch (view.name) {
    case 'reader':
      return <Reader key={view.songIds.join()} songIds={view.songIds} start={view.start} title={view.title} />;
    case 'song':
      return <SongEditor key={view.id} id={view.id} />;
    case 'setlist':
      return <SetlistView key={view.id} id={view.id} />;
    case 'settings':
      return <Settings />;
    case 'trash':
      return <Trash />;
    case 'tuner':
      return <Tuner />;
    default:
      return <Library />;
  }
}

export function SyncBadge() {
  const s = useSync();
  const signedIn = useSignedIn();
  let label: string;
  let cls = s.state;
  if (!signedIn) {
    label = drive.knownUser ? 'Touchez pour reconnecter' : 'Drive non connecté';
    cls = 'signed-out';
  } else if (s.state === 'syncing') label = 'Synchronisation…';
  else if (s.state === 'offline') label = 'Hors ligne';
  else if (s.state === 'error') label = 'Erreur de synchro';
  else if (s.missingFiles > 0) label = `Téléchargement (${s.missingFiles})`;
  else if (s.pendingFiles > 0) label = `Envoi (${s.pendingFiles})`;
  else label = 'Synchronisé';
  return (
    <button class={`sync-badge ${cls}`} title={s.message ?? ''} onClick={() => (signedIn ? sync.run() : go({ name: 'settings' }))}>
      <span class="dot" />
      {label}
    </button>
  );
}
