// Google Drive backend. Everything lives in a "Partitions" folder in the
// user's Drive:  Partitions/journal/*.json  and  Partitions/fichiers/*
// The drive.file scope only grants access to files this app created, on any
// device signed in to the same Google account.

import type { Journal, Remote, RemoteEntry } from './sync';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Partitions';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken(o?: { prompt?: string; login_hint?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(c: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string }) => void;
          }): TokenClient;
        };
      };
    };
  }
}

export class AuthError extends Error {}

export class DriveRemote implements Remote {
  private token = '';
  private expires = 0;
  private client?: TokenClient;
  private pending?: { resolve: (ok: boolean) => void };
  private folders?: { root: string; journal: string; files: string };
  private journalIds = new Map<string, string>();
  private blobIds = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(private clientId: string) {
    const saved = localStorage.getItem('drive.token');
    if (saved) {
      const { token, expires } = JSON.parse(saved);
      if (expires > Date.now() + 60_000) {
        this.token = token;
        this.expires = expires;
      }
    }
  }

  get signedIn() {
    return !!this.token && this.expires > Date.now() + 60_000;
  }

  // Has this device ever been connected? Then a silent refresh is possible.
  get knownUser() {
    return localStorage.getItem('drive.connected') === '1';
  }

  onAuthChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async gis(): Promise<TokenClient> {
    if (this.client) return this.client;
    if (!window.google?.accounts) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Impossible de charger Google Sign-In'));
        document.head.appendChild(s);
      });
    }
    this.client = window.google!.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPE,
      callback: (r) => {
        const ok = !!r.access_token;
        if (ok) {
          this.token = r.access_token!;
          this.expires = Date.now() + (r.expires_in ?? 3600) * 1000;
          localStorage.setItem('drive.token', JSON.stringify({ token: this.token, expires: this.expires }));
          localStorage.setItem('drive.connected', '1');
        }
        this.pending?.resolve(ok);
        this.pending = undefined;
        for (const fn of this.listeners) fn();
      },
      error_callback: () => {
        this.pending?.resolve(false);
        this.pending = undefined;
      },
    });
    return this.client;
  }

  // Must be called from a user gesture (tap/click): browsers block the
  // Google window otherwise. For a returning user it closes by itself.
  async signIn(): Promise<boolean> {
    const client = await this.gis();
    return new Promise((resolve) => {
      this.pending = { resolve };
      client.requestAccessToken({ prompt: this.knownUser ? '' : 'consent' });
    });
  }

  // Load the Google library ahead of time so signIn() runs synchronously
  // inside the gesture.
  preload() {
    void this.gis().catch(() => {});
  }

  signOut() {
    this.token = '';
    this.expires = 0;
    localStorage.removeItem('drive.token');
    localStorage.removeItem('drive.connected');
    for (const fn of this.listeners) fn();
  }

  async ready() {
    if (!this.signedIn) return false;
    if (!this.folders) await this.setupFolders();
    return true;
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.token}` },
    });
    if (res.status === 401) {
      this.token = '';
      localStorage.removeItem('drive.token');
      for (const fn of this.listeners) fn();
      throw new AuthError('Session Google expirée');
    }
    if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`);
    return res;
  }

  private async list(q: string): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    const out: { id: string; name: string; modifiedTime: string }[] = [];
    let pageToken = '';
    do {
      const p = new URLSearchParams({
        q: `${q} and trashed=false`,
        fields: 'nextPageToken,files(id,name,modifiedTime)',
        pageSize: '1000',
        spaces: 'drive',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await (await this.call(`${API}/files?${p}`)).json();
      out.push(...r.files);
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  private async folder(name: string, parent: string): Promise<string> {
    const found = await this.list(
      `name='${name}' and mimeType='${FOLDER}' and '${parent}' in parents`,
    );
    if (found.length) return found[0].id;
    const r = await this.call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    return (await r.json()).id;
  }

  private async setupFolders() {
    const root = await this.folder(ROOT_NAME, 'root');
    const [journal, files] = await Promise.all([this.folder('journal', root), this.folder('fichiers', root)]);
    this.folders = { root, journal, files };
  }

  async listJournals(): Promise<RemoteEntry[]> {
    const files = await this.list(`'${this.folders!.journal}' in parents`);
    for (const f of files) this.journalIds.set(f.name, f.id);
    return files.map((f) => ({ id: f.id, name: f.name, modified: f.modifiedTime }));
  }

  async readJournal(entry: RemoteEntry): Promise<Journal> {
    return (await this.call(`${API}/files/${entry.id}?alt=media`)).json();
  }

  async writeJournal(journal: Journal) {
    const name = `${journal.deviceId}.json`;
    const body = new Blob([JSON.stringify(journal)], { type: 'application/json' });
    let id = this.journalIds.get(name);
    if (!id) {
      const found = await this.list(`name='${name}' and '${this.folders!.journal}' in parents`);
      id = found[0]?.id;
    }
    if (id) {
      await this.call(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', body });
    } else {
      id = await this.upload(name, this.folders!.journal, body);
      this.journalIds.set(name, id);
    }
  }

  async listBlobs(): Promise<Set<string>> {
    const files = await this.list(`'${this.folders!.files}' in parents`);
    for (const f of files) this.blobIds.set(f.name, f.id);
    return new Set(files.map((f) => f.name));
  }

  async uploadBlob(name: string, blob: Blob) {
    const id = await this.upload(name, this.folders!.files, blob);
    this.blobIds.set(name, id);
  }

  // Resumable upload works for any size.
  private async upload(name: string, parent: string, blob: Blob): Promise<string> {
    const init = await this.call(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': blob.type || 'application/octet-stream',
      },
      body: JSON.stringify({ name, parents: [parent] }),
    });
    const location = init.headers.get('Location')!;
    const r = await this.call(location, { method: 'PUT', body: blob });
    return (await r.json()).id;
  }

  async downloadBlob(name: string): Promise<Blob> {
    let id = this.blobIds.get(name);
    if (!id) {
      const found = await this.list(`name='${name}' and '${this.folders!.files}' in parents`);
      if (!found.length) throw new Error(`Fichier absent du Drive : ${name}`);
      id = found[0].id;
      this.blobIds.set(name, id);
    }
    return (await this.call(`${API}/files/${id}?alt=media`)).blob();
  }
}
