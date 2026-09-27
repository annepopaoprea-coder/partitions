import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App, setUpdate } from './app';
import { store, sync } from './services';
import './styles.css';

async function boot() {
  await store.open();
  // Ask the browser not to evict cached scores (needed for offline use).
  void navigator.storage?.persist?.();
  render(<App />, document.getElementById('app')!);
  // A new version is offered, never forced: reloading mid-performance would
  // lose the page being read.
  const update = registerSW({
    onNeedRefresh: () => setUpdate(() => update(true)),
    onRegisteredSW: (_url, reg) => reg && setInterval(() => void reg.update(), 30 * 60 * 1000),
  });
  sync.start();
}

void boot();
