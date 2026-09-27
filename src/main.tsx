import { render } from 'preact';
import { App } from './app';
import { store, sync } from './services';
import './styles.css';

async function boot() {
  await store.open();
  // Ask the browser not to evict cached scores (needed for offline use).
  void navigator.storage?.persist?.();
  render(<App />, document.getElementById('app')!);
  sync.start();
}

void boot();
