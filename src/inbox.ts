// Files arriving from outside the app: Android's share menu (via the service
// worker, see public/share-target.js) and "Open with" on computers (File
// Handling API). They wait here until the user confirms how to add them.

type Listener = (files: File[]) => void;

let pending: File[] = [];
const listeners = new Set<Listener>();

function add(files: File[]) {
  if (!files.length) return;
  pending = [...pending, ...files];
  for (const fn of listeners) fn(pending);
}

export function onIncoming(fn: Listener) {
  listeners.add(fn);
  fn(pending);
  return () => listeners.delete(fn);
}

export function clearIncoming() {
  pending = [];
  for (const fn of listeners) fn(pending);
  void caches.open('partitions-inbox').then(async (c) => {
    for (const k of await c.keys()) await c.delete(k);
  });
}

async function fromShareInbox(): Promise<File[]> {
  if (!('caches' in window)) return [];
  const cache = await caches.open('partitions-inbox');
  const files: File[] = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get('X-File-Name') ?? 'document.pdf');
    files.push(new File([await res.blob()], name, { type: res.headers.get('Content-Type') ?? '' }));
  }
  return files;
}

interface LaunchParams {
  files: FileSystemFileHandle[];
}

export function listenForIncoming() {
  const url = new URL(location.href);
  if (url.searchParams.has('shared') || url.searchParams.has('open-file')) {
    url.searchParams.delete('shared');
    url.searchParams.delete('open-file');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  // Anything shared, even while the app was closed or locked.
  void fromShareInbox().then(add);
  const queue = (window as unknown as { launchQueue?: { setConsumer(fn: (p: LaunchParams) => void): void } }).launchQueue;
  queue?.setConsumer(async (params) => {
    add(await Promise.all((params.files ?? []).map((h) => h.getFile())));
  });
}
