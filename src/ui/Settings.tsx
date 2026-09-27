import { useRef, useState } from 'preact/hooks';
import { back } from '../app';
import type { Rec } from '../model';
import { SecuritySection } from './Lock';
import { clientId, deviceName, drive, store, sync, useSignedIn, useSync } from '../services';

export function Settings() {
  const signedIn = useSignedIn();
  const status = useSync();
  const [name, setName] = useState(deviceName());
  const [cid, setCid] = useState(clientId());
  const [importMsg, setImportMsg] = useState('');
  const dir = useRef<HTMLInputElement>(null);

  async function onImport(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    (e.target as HTMLInputElement).value = '';
    const lib = files.find((f) => f.name === 'bibliotheque.json');
    if (!lib) return setImportMsg('Dossier invalide : bibliotheque.json introuvable.');
    const data = JSON.parse(await lib.text()) as { source: string; records: Rec[] };
    const key = `imported:${data.source}`;
    if ((await store.getMeta(key)) && !confirm('Cette sauvegarde a déjà été importée. Importer à nouveau (doublons) ?')) return;
    const blobs = files.filter((f) => f.webkitRelativePath.includes('/fichiers/'));
    let n = 0;
    for (const f of blobs) {
      const type = f.name.endsWith('.pdf') ? 'application/pdf' : f.type;
      await store.putBlob(f.name, new Blob([f], { type }));
      await sync.queueBlob(f.name);
      setImportMsg(`Fichiers copiés : ${++n} / ${blobs.length}`);
    }
    // Imported records become this device's own edits, so they sync out.
    await store.put(data.records);
    await store.setMeta(key, true);
    const songs = data.records.filter((r) => r.kind === 'song').length;
    setImportMsg(`${songs} morceaux importés. Envoi vers Google Drive en cours…`);
    void sync.run();
  }

  return (
    <div class="screen">
      <header class="topbar">
        <button class="icon" onClick={back}>
          ←
        </button>
        <h1>Réglages</h1>
      </header>
      <div class="form">
        <section>
          <h2>Google Drive</h2>
          {!clientId() ? (
            <>
              <p>Collez l'identifiant client OAuth Google de l'app (fourni lors de l'installation).</p>
              <input value={cid} placeholder="xxxxxxxx.apps.googleusercontent.com" onInput={(e) => setCid((e.target as HTMLInputElement).value.trim())} />
              <button
                class="primary"
                onClick={() => {
                  localStorage.setItem('google.clientId', cid);
                  location.reload();
                }}
              >
                Enregistrer
              </button>
            </>
          ) : signedIn ? (
            <>
              <p>Connecté. Les partitions sont dans le dossier « Partitions » de votre Google Drive.</p>
              <button onClick={() => drive.signOut()}>Se déconnecter</button>
            </>
          ) : (
            <button class="primary" onClick={() => drive.signIn().then((ok) => void (ok && sync.run()))}>
              Se connecter à Google Drive
            </button>
          )}
        </section>

        <SecuritySection />

        <section>
          <h2>Synchronisation</h2>
          <p>
            État : <b>{labelFor(status.state)}</b>
            {status.lastSync && <> · dernière synchro {new Date(status.lastSync).toLocaleTimeString('fr')}</>}
          </p>
          {status.message && <p class="error">{status.message}</p>}
          {status.pendingFiles > 0 && <p>{status.pendingFiles} fichier(s) à envoyer</p>}
          {status.missingFiles > 0 && <p>{status.missingFiles} fichier(s) à télécharger</p>}
          <p class="hint">
            La synchronisation est automatique : à l'ouverture, quelques secondes après chaque modification et toutes les
            minutes.
          </p>
          <button onClick={() => sync.run()}>Synchroniser maintenant</button>
        </section>

        <section>
          <h2>Cet appareil</h2>
          <label>
            Nom
            <input
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onChange={() => localStorage.setItem('deviceName', name.trim() || deviceName())}
            />
          </label>
          <p class="hint">Identifiant : {store.deviceId}</p>
        </section>

        <section>
          <h2>Importer une bibliothèque MobileSheets</h2>
          <p class="hint">Choisissez le dossier préparé à partir d'une sauvegarde .msb (il contient bibliotheque.json).</p>
          <button onClick={() => dir.current?.click()}>Choisir le dossier…</button>
          <input
            ref={(el) => {
              dir.current = el;
              el?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            hidden
            onChange={onImport}
          />
          {importMsg && <p>{importMsg}</p>}
        </section>
      </div>
    </div>
  );
}

function labelFor(s: string) {
  return (
    { idle: 'à jour', syncing: 'en cours', offline: 'hors ligne', 'signed-out': 'non connecté', error: 'erreur' } as Record<string, string>
  )[s];
}
