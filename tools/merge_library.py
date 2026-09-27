#!/usr/bin/env python3
"""Merge several MobileSheets backups (.msb) and loose score files into one
Partitions import folder, removing duplicates.

Usage: merge_library.py <output-dir> <source> [<source> ...]
  A source is a .msb file or a folder (searched recursively for .msb, .pdf
  and image files).

Duplicates:
  - Songs whose files have identical content (SHA-256) are merged into one:
    groups (students, years, collections...) are combined, setlists point to
    the kept song, and for each page the most complete annotations win.
  - Loose files whose content is already in a backup are skipped.
  - Songs with the same title but different content are all kept and listed
    in the report for a manual decision.

Output: <output-dir>/fichiers/*, bibliotheque.json, rapport.md
"""

import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
import tempfile
import time
import unicodedata
import uuid

FILE_MAGIC = 0x11DEDA2C5161659C
FLT_MAX = 3.0e38
SCORE_EXT = {'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff'}
MIME = {'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp', 'tif': 'image/tiff', 'tiff': 'image/tiff'}
GROUP_TABLES = [  # table, name column, link table, group type
    ('Collections', 'Name', 'CollectionSong', 'collection'),
    ('Artists', 'Name', 'ArtistsSongs', 'artist'),
    ('Composer', 'Name', 'ComposerSongs', 'composer'),
    ('Books', 'Title', 'BookSongs', 'album'),
    ('Genres', 'Type', 'GenresSongs', 'genre'),
    ('CustomGroup', 'Name', 'CustomGroupSongs', 'collection'),
]


def norm(s):
    s = unicodedata.normalize('NFD', s or '').encode('ascii', 'ignore').decode().lower()
    return ' '.join(s.split())


def title_key(s):
    """Loose title used to spot same-title songs (ignores "(1)", case, accents)."""
    s = norm(re.sub(r'\.(pdf|jpe?g|png)$', '', s or '', flags=re.I))
    s = re.sub(r'\(\d+\)', ' ', s)
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', s).split())


GENERIC_TITLE = re.compile(r'^(\d{4}-\d\d-\d\d|screenshot|img[_ -]?\d|scan|document|att\.)', re.I)


def title_rank(title, modified):
    """Prefer descriptive titles over file-name leftovers when merging copies."""
    t = (title or '').strip()
    return (not GENERIC_TITLE.match(t), not re.search(r'\(\d+\)\s*$', t), len(t), modified)


def color(argb):
    c = argb & 0xFFFFFFFF
    return '#%06x' % (c & 0xFFFFFF), ((c >> 24) & 0xFF) / 255


class Library:
    def __init__(self, out):
        self.out = out
        self.files_dir = os.path.join(out, 'fichiers')
        os.makedirs(self.files_dir, exist_ok=True)
        self.blobs = {}  # sha256 -> FileRef
        self.songs = {}  # key (tuple of hashes) -> merged song
        self.groups = {}  # (type, norm name) -> group record
        self.setlists = {}  # norm name -> setlist
        self.log = {'sources': [], 'merged': [], 'loose_skipped': [], 'loose_added': [], 'empty': [], 'superseded': [], 'missing': [], 'unsupported': []}
        self.library_files = set()  # files already read through a library database
        self.source_time = {}  # source label -> backup date (for newest-version-wins)

    # -- files ------------------------------------------------------------

    def store_blob(self, data, name):
        h = hashlib.sha256(data).hexdigest()
        if h not in self.blobs:
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else 'pdf'
            if ext not in SCORE_EXT and data[:5] == b'%PDF-':
                ext = 'pdf'
            fid = str(uuid.uuid4())
            with open(os.path.join(self.files_dir, f'{fid}.{ext}'), 'wb') as o:
                o.write(data)
            self.blobs[h] = {'id': fid, 'name': name, 'mime': MIME.get(ext, 'application/octet-stream'), 'size': len(data)}
        return h

    def blobs_by_hash(self, h):
        return self.blobs[h]

    # -- groups -------------------------------------------------------------

    def group(self, gtype, name):
        key = (gtype, norm(name))
        if key not in self.groups:
            self.groups[key] = {'id': str(uuid.uuid4()), 'kind': 'group', 'type': gtype, 'name': name.strip()}
        return self.groups[key]['id']

    # -- songs --------------------------------------------------------------

    def add_song(self, hashes, title, modified, created, groups, key, anns, source):
        """Add a song; merge it into an existing one with the same files."""
        k = tuple(hashes)
        s = self.songs.get(k)
        if s is None:
            s = self.songs[k] = {'title': title, 'modified': modified, 'created': created, 'groups': {},
                                 'key': key, 'anns': {}, 'sources': [], 'id': str(uuid.uuid4())}
        else:
            self.log['merged'].append((title, source, s['sources'][0]))
            if title_rank(title, modified) > title_rank(s['title'], s['modified']):
                s['title'] = title
            s['modified'] = max(s['modified'], modified)
            s['created'] = min(s['created'], created) if s['created'] and created else s['created'] or created
            s['key'] = s['key'] or key
        s['sources'].append(source)
        for gtype, ids in groups.items():
            cur = s['groups'].setdefault(gtype, [])
            cur.extend(i for i in ids if i not in cur)
        for page, items in anns.items():
            prev = s['anns'].get(page)
            if prev is None or len(items) > len(prev[0]) or (len(items) == len(prev[0]) and modified > prev[1]):
                s['anns'][page] = (items, modified)
        return s['id']

    def add_setlist(self, name, song_ids, modified):
        k = norm(name)
        cur = self.setlists.get(k)
        if cur is None:
            self.setlists[k] = {'name': name, 'songs': list(song_ids), 'modified': modified}
            return
        # Keep the most recent order, then append songs only the other had.
        first, second = (song_ids, cur['songs']) if modified > cur['modified'] else (cur['songs'], song_ids)
        cur['songs'] = list(first) + [s for s in second if s not in first]
        cur['modified'] = max(modified, cur['modified'])

    # -- sources ------------------------------------------------------------

    def read_msb(self, path):
        label = os.path.basename(path)
        self.source_time[label] = os.path.getmtime(path)
        f = open(path, 'rb')
        head = f.read(4 * 1024 * 1024)
        i = head.find(b'SQLite format 3\x00')
        if i < 8:
            print(f'  ! {label}: base introuvable, ignoré')
            return
        size = struct.unpack('>q', head[i - 8:i])[0]
        f.seek(i)
        tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        tmp.write(f.read(size))
        tmp.close()
        db = sqlite3.connect(tmp.name)
        files_by_song = self.file_rows(db)

        # File contents follow the database, keyed by song id.
        n = 0
        while True:
            h = f.read(24)
            if len(h) < 24:
                break
            magic, sid, fsize = struct.unpack('>QqQ', h)
            if magic != FILE_MAGIC:
                break
            data = f.read(fsize)
            rows = files_by_song.get(sid, [])
            free = [r for r in rows if r[2] is None]
            row = next((r for r in free if r[1] == fsize), free[0] if free else None)
            if row is None:
                continue
            row[2] = self.store_blob(data, row[0] or f'{sid}.pdf')
            n += 1
        self.read_db(db, label, files_by_song, n)
        db.close()
        os.unlink(tmp.name)

    def read_folder(self, db_path):
        """A copied MobileSheets storage folder: mobilesheets.db next to the
        score files it references (matched by file name)."""
        folder = os.path.dirname(db_path)
        label = f'bibliothèque MobileSheets ({os.path.basename(folder) or "racine"})'
        self.source_time[label] = os.path.getmtime(db_path)
        tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        with open(db_path, 'rb') as src:
            tmp.write(src.read())
        tmp.close()
        db = sqlite3.connect(tmp.name)
        files_by_song = self.file_rows(db)
        n = 0
        for rows in files_by_song.values():
            for row in rows:
                p = os.path.join(folder, row[0])
                if os.path.isfile(p):
                    with open(p, 'rb') as fh:
                        row[2] = self.store_blob(fh.read(), row[0])
                    n += 1
                    self.library_files.add(os.path.abspath(p))
                else:
                    self.log['missing'].append((row[0], label))
        self.read_db(db, label, files_by_song, n)
        db.close()
        os.unlink(tmp.name)

    @staticmethod
    def file_rows(db):
        rows = {}
        for fid, sid, fpath, fsize in db.execute('SELECT Id, SongId, Path, FileSize FROM Files ORDER BY Id'):
            rows.setdefault(sid, []).append([os.path.basename(fpath or ''), fsize, None])
        return rows

    def read_db(self, db, label, files_by_song, n):
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        group_ids = {}  # (type, ms id) -> our id
        song_groups = {}  # ms song id -> {type: [ids]}
        for table, col, link, gtype in GROUP_TABLES:
            if table not in tables or link not in tables:
                continue
            lcols = [r[1] for r in db.execute(f'PRAGMA table_info("{link}")')]
            gcol = next(c for c in lcols if c not in ('Id', 'SongId'))
            for gid, name in db.execute(f'SELECT Id, "{col}" FROM "{table}"'):
                if name and name.strip():
                    group_ids[(gtype, gid)] = self.group(gtype, name)
            for gid, sid in db.execute(f'SELECT "{gcol}", SongId FROM "{link}"'):
                if (gtype, gid) in group_ids:
                    lst = song_groups.setdefault(sid, {}).setdefault(gtype, [])
                    if group_ids[(gtype, gid)] not in lst:
                        lst.append(group_ids[(gtype, gid)])

        keys = {}
        if 'KeySongs' in tables:
            kcols = [r[1] for r in db.execute('PRAGMA table_info(KeySongs)')]
            kcol = next(c for c in kcols if c not in ('Id', 'SongId'))
            names = dict(db.execute('SELECT Id, Name FROM Key'))
            for kid, sid in db.execute(f'SELECT "{kcol}", SongId FROM KeySongs'):
                if names.get(kid):
                    keys[sid] = names[kid]

        anns = self.read_annotations(db)
        ours = {}
        songs = 0
        for sid, title, created, modified in db.execute('SELECT Id, Title, CreationDate, LastModified FROM Songs'):
            rows = files_by_song.get(sid, [])
            for r in rows:
                if r[2] and self.blobs_by_hash(r[2])['mime'] == 'application/octet-stream':
                    self.log['unsupported'].append((title, r[0]))
            hashes = [r[2] for r in rows if r[2] and self.blobs_by_hash(r[2])['mime'] != 'application/octet-stream']
            if not hashes:
                self.log['empty'].append((title, label))
                continue
            ours[sid] = self.add_song(hashes, title or 'Sans titre', modified or 0, created or 0,
                                      song_groups.get(sid, {}), keys.get(sid), anns.get(sid, {}), label)
            songs += 1

        setlists = 0
        for lid, name, modified in db.execute('SELECT Id, Name, LastModified FROM Setlists'):
            ids = [ours[s] for (s,) in db.execute('SELECT SongId FROM SetlistSong WHERE SetlistId=? ORDER BY Id', (lid,)) if s in ours]
            self.add_setlist(name or 'Setlist', ids, modified or 0)
            setlists += 1
        self.log['sources'].append(f'{label} : {songs} morceaux, {n} fichiers, {setlists} setlists')
        print(f'  {label} : {songs} morceaux, {setlists} setlists')

    def read_annotations(self, db):
        out = {}
        q = '''SELECT b.SongId, b.Page, b.Type, b.Opacity, b.SourcePageWidth, b.SourcePageHeight,
                      d.LineColor, d.LineWidth, p.Points
               FROM AnnotationsBase b JOIN DrawAnnotations d ON d.BaseId = b.Id
               JOIN AnnotationPoints p ON p.AnnotationId = b.Id'''
        for sid, page, atype, opacity, w, hgt, lc, lw, blob in db.execute(q):
            if not w or not hgt or not blob:
                continue
            v = struct.unpack('<%dd' % (len(blob) // 8), blob)
            col, a = color(lc)
            alpha = a * (opacity or 100) / 100
            # Type 2 is the highlighter: see-through, except white, which is
            # used to mask printed marks and must stay opaque.
            if atype == 2 and col != '#ffffff':
                alpha = min(alpha, 0.35)
            if atype == 6:
                chunks = [list(v[:4])]
            else:
                chunks, cur = [], []
                pts = v[3:]
                for i in range(0, len(pts) - 1, 2):
                    x, y = pts[i], pts[i + 1]
                    if x > FLT_MAX or y > FLT_MAX:
                        if cur:
                            chunks.append(cur)
                        cur = []
                    else:
                        cur += [x, y]
                if cur:
                    chunks.append(cur)
            for c in chunks:
                if len(c) < 2:
                    continue
                pts = [round(c[i] / (w if i % 2 == 0 else hgt), 5) for i in range(len(c))]
                if len(pts) == 2:
                    pts += pts
                out.setdefault(sid, {}).setdefault(page, []).append(
                    {'t': 'stroke', 'color': col, 'width': round(lw / w, 5), 'alpha': round(alpha, 3), 'pts': pts})
        q = '''SELECT b.SongId, b.Page, b.SourcePageWidth, b.SourcePageHeight, t.Text, t.TextColor, t.FontSize, p.Points
               FROM AnnotationsBase b JOIN TextboxAnnotations t ON t.BaseId = b.Id
               LEFT JOIN AnnotationPoints p ON p.AnnotationId = b.Id'''
        for sid, page, w, hgt, text, tc, fs, blob in db.execute(q):
            if not text or not w or not hgt:
                continue
            x = y = 0.1
            if blob and len(blob) >= 16:
                x, y = struct.unpack('<2d', blob[:16])
                x, y = x / w, y / hgt
            out.setdefault(sid, {}).setdefault(page, []).append(
                {'t': 'text', 'color': color(tc)[0], 'size': round((fs or 12) / hgt, 5),
                 'x': round(x, 5), 'y': round(y, 5), 'text': text.strip()})
        return out

    def read_loose(self, path):
        if os.path.abspath(path) in self.library_files:
            return
        with open(path, 'rb') as fh:
            data = fh.read()
        h = hashlib.sha256(data).hexdigest()
        name = os.path.basename(path)
        if h in self.blobs:
            self.log['loose_skipped'].append(path)
            return
        self.store_blob(data, name)
        self.log['loose_added'].append(path)
        self.add_song([h], re.sub(r'\.[^.]+$', '', name), int(os.path.getmtime(path) * 1000),
                      int(os.path.getmtime(path) * 1000), {}, None, {}, 'fichier : ' + path)

    # -- versions -----------------------------------------------------------

    def drop_superseded(self):
        """A song edited between two backups has the same title and file name
        but new content. Keep the version from the newest backup only."""
        def newest(s):
            return max(self.source_time.get(x, 0) for x in s['sources'])

        def names(s):
            return tuple(sorted(self.blobs[h]['name'] for h in self.song_key(s)))

        groups = {}
        for s in self.songs.values():
            groups.setdefault((title_key(s['title']), names(s)), []).append(s)
        drop = []
        for same in groups.values():
            if len(same) < 2:
                continue
            best = max(newest(s) for s in same)
            for s in same:
                if newest(s) < best:
                    drop.append(s)
        for s in drop:
            keeper = max((x for x in groups[(title_key(s['title']), names(s))] if x is not s), key=newest)
            # Setlists that pointed to the old version now point to the new one.
            for sl in self.setlists.values():
                sl['songs'] = _unique(keeper['id'] if i == s['id'] else i for i in sl['songs'])
            for gtype, ids in s['groups'].items():
                cur = keeper['groups'].setdefault(gtype, [])
                cur.extend(i for i in ids if i not in cur)
            del self.songs[self.song_key(s)]
            self.log['superseded'].append((s['title'], ', '.join(sorted(set(s['sources'])))))

    # -- output -------------------------------------------------------------

    def write(self):
        self.drop_superseded()
        now = int(time.time() * 1000)
        base = {'updatedAt': now, 'deviceId': 'import-mobilesheets'}
        records = []
        used_groups = set()
        for s in self.songs.values():
            files = [self.blobs[h] for h in _unique(k for k in self.song_key(s))]
            rec = {**base, 'id': s['id'], 'kind': 'song', 'title': s['title'], 'files': files,
                   'groups': s['groups'], 'createdAt': s['created'] or now}
            if s['key']:
                rec['key'] = s['key']
            records.append(rec)
            for ids in s['groups'].values():
                used_groups.update(ids)
            for page, (items, _) in s['anns'].items():
                records.append({**base, 'id': f"ann:{s['id']}:{page}", 'kind': 'ann', 'songId': s['id'],
                                'page': page, 'items': items})
        records += [{**base, **g} for g in self.groups.values() if g['id'] in used_groups]
        for sl in self.setlists.values():
            records.append({**base, 'id': str(uuid.uuid4()), 'kind': 'setlist', 'name': sl['name'],
                            'songIds': sl['songs'], 'createdAt': sl['modified'] or now})
        with open(os.path.join(self.out, 'bibliotheque.json'), 'w') as o:
            json.dump({'source': 'fusion-' + time.strftime('%Y%m%d-%H%M%S'), 'records': records}, o, ensure_ascii=False)
        self.write_report(records)

    def song_key(self, s):
        return next(k for k, v in self.songs.items() if v is s)

    def write_report(self, records):
        kinds = {}
        for r in records:
            kinds[r['kind']] = kinds.get(r['kind'], 0) + 1
        by_title = {}
        for s in self.songs.values():
            by_title.setdefault(title_key(s['title']), []).append(s)
        same_title = [v for v in by_title.values() if len(v) > 1]
        size = sum(b['size'] for b in self.blobs.values())
        L = ['# Rapport de fusion', '']
        L += ['## Sources'] + [f'- {x}' for x in self.log['sources']]
        if self.log['loose_added'] or self.log['loose_skipped']:
            L.append(f"- Fichiers isolés : {len(self.log['loose_added'])} ajoutés, "
                     f"{len(self.log['loose_skipped'])} ignorés (déjà présents)")
        L += ['', '## Résultat',
              f"- **{kinds.get('song', 0)} morceaux** ({len(self.blobs)} fichiers, {size / 1e6:.0f} Mo)",
              f"- {kinds.get('setlist', 0)} setlists, {kinds.get('group', 0)} groupes, {kinds.get('ann', 0)} pages annotées",
              f"- {len(self.log['merged'])} doublons fusionnés (même contenu)",
              f"- {len(self.log['superseded'])} anciennes versions remplacées par une version plus récente",
              '', f'## Même titre, contenu différent ({len(same_title)}) — à vérifier', '']
        for group in sorted(same_title, key=lambda g: title_key(g[0]['title'])):
            L.append(f"- **{group[0]['title']}**")
            for s in group:
                names = ', '.join(self.blobs[h]['name'] for h in self.song_key(s))
                L.append(f"  - « {s['title']} » — {names} ({', '.join(sorted(set(s['sources'])))})")
        if self.log['superseded']:
            L += ['', f"## Anciennes versions écartées ({len(self.log['superseded'])})"]
            L += [f'- {t} (seulement dans : {src})' for t, src in self.log['superseded']]
        if self.log['missing']:
            L += ['', f"## Fichiers introuvables ({len(self.log['missing'])})"]
            L += [f'- {n} ({src})' for n, src in self.log['missing']]
        if self.log['unsupported']:
            L += ['', f"## Fichiers non pris en charge ({len(self.log['unsupported'])})"]
            L += [f'- {t} — {n}' for t, n in self.log['unsupported']]
        if self.log['loose_added']:
            L += ['', f"## Fichiers isolés ajoutés sans classement ({len(self.log['loose_added'])})"]
            L += [f'- {os.path.basename(p)}' for p in self.log['loose_added']]
        if self.log['empty']:
            L += ['', f"## Morceaux sans fichier, ignorés ({len(self.log['empty'])})"]
            L += [f'- {t} ({src})' for t, src in self.log['empty']]
        with open(os.path.join(self.out, 'rapport.md'), 'w') as o:
            o.write('\n'.join(L) + '\n')


def _unique(items):
    seen = []
    for i in items:
        if i not in seen:
            seen.append(i)
    return seen


def main(out, sources):
    lib = Library(out)
    msbs, loose, dbs = [], [], []
    for src in sources:
        if os.path.isfile(src):
            if src.lower().endswith('.db'):
                dbs.append(src)
            else:
                (msbs if src.lower().endswith('.msb') else loose).append(src)
            continue
        for root, _, names in os.walk(src):
            if os.path.abspath(root).startswith(os.path.abspath(out)):
                continue
            for n in names:
                p = os.path.join(root, n)
                ext = n.rsplit('.', 1)[-1].lower()
                if ext == 'msb':
                    msbs.append(p)
                elif n.lower() == 'mobilesheets.db':
                    dbs.append(p)
                elif ext in SCORE_EXT:
                    loose.append(p)
    # Newest backups first, so their titles and order win ties.
    msbs.sort(key=os.path.getmtime, reverse=True)
    print(f'{len(dbs)} bibliothèque(s), {len(msbs)} sauvegarde(s), {len(loose)} fichier(s) isolé(s)')
    for d in dbs:
        lib.read_folder(d)
    for m in msbs:
        lib.read_msb(m)
    for p in loose:
        lib.read_loose(p)
    lib.write()
    print(open(os.path.join(out, 'rapport.md')).read().split('## Même titre')[0])


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
