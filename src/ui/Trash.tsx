import { back } from '../app';
import { GROUP_LABELS, type Rec } from '../model';
import { store, useStore } from '../services';

function describe(r: Rec): { kind: string; name: string } {
  switch (r.kind) {
    case 'song':
      return { kind: 'Morceau', name: r.title };
    case 'setlist':
      return { kind: 'Setlist', name: r.name };
    case 'group':
      return { kind: GROUP_LABELS[r.type].one, name: r.name };
    default:
      return { kind: '', name: '' };
  }
}

export function Trash() {
  useStore();
  const items = store.trash();
  return (
    <div class="screen">
      <header class="topbar">
        <button class="icon" onClick={back}>
          ←
        </button>
        <h1>Corbeille</h1>
      </header>
      <p class="hint trash-hint">
        Les éléments supprimés restent ici 30 jours, sur tous vos appareils. Les fichiers ne sont jamais effacés de votre
        Drive.
      </p>
      {!items.length && <p class="empty">La corbeille est vide.</p>}
      <ul class="list">
        {items.map((r) => {
          const { kind, name } = describe(r);
          const days = Math.max(0, 30 - Math.floor((Date.now() - (r.deletedAt ?? 0)) / 86_400_000));
          return (
            <li key={r.id}>
              <div class="row">
                <span class="title">{name}</span>
                <span class="sub">
                  {kind} · supprimé le {new Date(r.deletedAt ?? 0).toLocaleDateString('fr')} · encore {days} jour
                  {days > 1 ? 's' : ''}
                </span>
              </div>
              <button onClick={() => store.restore(r)}>Restaurer</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
