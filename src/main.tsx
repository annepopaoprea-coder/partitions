import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App, setUpdate } from './app';
import { listenForIncoming } from './inbox';
import { store, sync } from './services';
import './styles.css';

async function boot() {
  await store.open();
  // Ask the browser not to evict cached scores (needed for offline use).
  void navigator.storage?.persist?.();
  listenForIncoming();
  render(<App />, document.getElementById('app')!);
  // A new version is offered, never forced: reloading mid-performance would
  // lose the page being read.
  const update = registerSW({
    onNeedRefresh: () => setUpdate(() => update(true)),
    onRegisteredSW: (_url, reg) => {
      if (!reg) return;
      // Look for a new version regularly and whenever the app comes back to screen.
      setInterval(() => void reg.update(), 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update();
      });
    },
  });
  sync.start();
}

void boot();
