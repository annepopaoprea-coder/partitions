#!/usr/bin/env python3
"""Convert a MobileSheets backup (.msb) into a Partitions import folder.

Usage: import_msb.py <backup.msb> <output-dir>

The output folder holds `fichiers/<id>.<ext>` and `bibliotheque.json`; open
Partitions > Réglages > Importer une bibliothèque and pick that folder.

.msb layout (reverse-engineered, backup version 33):
  magic(4) version(int32 BE)
  settings entries: name (Java UTF: u16 len + bytes) + size (int64 BE) + data,
  terminated by an empty name
  user filters: int32 0 + int32 len + UTF-16 XML (skipped by searching for the DB)
  int64 size + SQLite database
  file records: FILE_MAGIC(int64) songId(int64) size(int64) data, ... then int64 -1
"""

import json
import os
import sqlite3
import struct
import sys
import tempfile
import time
import uuid

FILE_MAGIC = 0x11DEDA2C5161659C
FLT_MAX = 3.0e38

MIME = {'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp', 'tif': 'image/tiff', 'tiff': 'image/tiff'}

GROUP_TABLES = [  # (table, name column, link table, group type)
    ('Collections', 'Name', 'CollectionSong', 'collection'),
    ('Artists', 'Name', 'ArtistsSongs', 'artist'),
    ('Composer', 'Name', 'ComposerSongs', 'composer'),
    ('Books', 'Title', 'BookSongs', 'album'),
    ('Genres', 'Type', 'GenresSongs', 'genre'),
]


def color(argb):
    c = argb & 0xFFFFFFFF
    return '#%06x' % (c & 0xFFFFFF), ((c >> 24) & 0xFF) / 255


def find_db(f):
    """Locate the SQLite database; return (offset, size)."""
    head = f.read(4 * 1024 * 1024)
    i = head.find(b'SQLite format 3\x00')
    if i < 8:
        sys.exit('Base de données introuvable dans la sauvegarde')
    size = struct.unpack('>q', head[i - 8:i])[0]
    return i, size


def cols(db, table):
    return {r[1] for r in db.execute(f'PRAGMA table_info("{table}")')}


def main(src, out):
    os.makedirs(os.path.join(out, 'fichiers'), exist_ok=True)
    now = int(time.time() * 1000)
    base = {'updatedAt': now, 'deviceId': 'import-mobilesheets'}
    f = open(src, 'rb')
    off, size = find_db(f)
    f.seek(off)
    tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
    tmp.write(f.read(size))
    tmp.close()
    db = sqlite3.connect(tmp.name)

    songs = {}
    for sid, title, created, modified in db.execute('SELECT Id, Title, CreationDate, LastModified FROM Songs'):
        songs[sid] = {**base, 'id': str(uuid.uuid4()), 'kind': 'song', 'title': title or 'Sans titre',
                      'files': [], 'groups': {}, 'createdAt': created or modified or now}

    records = []
    for table, name_col, link, gtype in GROUP_TABLES:
        if table not in {r[0] for r in db.execute("SELECT name FROM sqlite_master")}:
            continue
        link_cols = cols(db, link)
        gcol = next(c for c in link_cols if c not in ('Id', 'SongId'))
        ids = {}
        for gid, name in db.execute(f'SELECT Id, "{name_col}" FROM "{table}"'):
            if not name:
                continue
            ids[gid] = str(uuid.uuid4())
            records.append({**base, 'id': ids[gid], 'kind': 'group', 'type': gtype, 'name': name})
        for gid, sid in db.execute(f'SELECT "{gcol}", SongId FROM "{link}"'):
            if gid in ids and sid in songs:
                songs[sid]['groups'].setdefault(gtype, []).append(ids[gid])

    key_names = dict(db.execute('SELECT Id, Name FROM Key'))
    for kid, sid in db.execute('SELECT KeyId, SongId FROM KeySongs') if 'KeyId' in cols(db, 'KeySongs') else []:
        if sid in songs and key_names.get(kid):
            songs[sid]['key'] = key_names[kid]

    # Files: the backup stores their contents keyed by song id, in the same
    # order as the Files table rows for that song.
    files_by_song = {}
    for fid, sid, path, fsize in db.execute('SELECT Id, SongId, Path, FileSize FROM Files ORDER BY Id'):
        files_by_song.setdefault(sid, []).append((path, fsize))
    f.seek(off + size)
    taken = {}
    count = 0
    while True:
        h = f.read(24)
        if len(h) < 24:
            break
        magic, sid, fsize = struct.unpack('>QqQ', h)
        if magic != FILE_MAGIC:
            break
        data = f.read(fsize)
        candidates = files_by_song.get(sid, [])
        idx = taken.get(sid, 0)
        # Prefer the row whose recorded size matches.
        match = next((i for i, (_, s) in enumerate(candidates) if s == fsize), idx)
        taken[sid] = idx + 1
        if sid not in songs or not candidates:
            continue
        path = candidates[min(match, len(candidates) - 1)][0]
        name = os.path.basename(path)
        ext = name.rsplit('.', 1)[-1].lower() if '.' in name else 'pdf'
        blob_id = str(uuid.uuid4())
        with open(os.path.join(out, 'fichiers', f'{blob_id}.{ext}'), 'wb') as o:
            o.write(data)
        songs[sid]['files'].append({'id': blob_id, 'name': name,
                                    'mime': MIME.get(ext, 'application/octet-stream'), 'size': fsize})
        count += 1

    # Setlists keep their song order.
    for lid, name, created in db.execute('SELECT Id, Name, DateCreated FROM Setlists'):
        order = [songs[s]['id'] for (s,) in db.execute(
            'SELECT SongId FROM SetlistSong WHERE SetlistId=? ORDER BY Id', (lid,)) if s in songs]
        records.append({**base, 'id': str(uuid.uuid4()), 'kind': 'setlist', 'name': name or 'Setlist',
                        'songIds': order, 'createdAt': created or now})

    # Annotations: coordinates are in source-page units; convert to 0..1.
    pages = {}
    q = '''SELECT b.Id, b.SongId, b.Page, b.Type, b.Opacity, b.SourcePageWidth, b.SourcePageHeight,
                  d.LineColor, d.LineWidth, p.Points
           FROM AnnotationsBase b JOIN DrawAnnotations d ON d.BaseId = b.Id
           JOIN AnnotationPoints p ON p.AnnotationId = b.Id'''
    for aid, sid, page, atype, opacity, w, hgt, lc, lw, blob in db.execute(q):
        if sid not in songs or not w or not hgt or not blob:
            continue
        v = struct.unpack('<%dd' % (len(blob) // 8), blob)
        col, a = color(lc)
        alpha = a * (opacity or 100) / 100
        if atype == 6:  # straight line
            chunks = [list(v[:4])]
        else:  # freehand: [flags, n, width, x, y, ...] with FLT_MAX separators
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
            norm = [round(c[i] / (w if i % 2 == 0 else hgt), 5) for i in range(len(c))]
            if len(norm) == 2:
                norm += norm
            pages.setdefault((sid, page), []).append(
                {'t': 'stroke', 'color': col, 'width': round(lw / w, 5), 'alpha': round(alpha, 3), 'pts': norm})

    q = '''SELECT b.SongId, b.Page, b.SourcePageWidth, b.SourcePageHeight, t.Text, t.TextColor, t.FontSize, p.Points
           FROM AnnotationsBase b JOIN TextboxAnnotations t ON t.BaseId = b.Id
           LEFT JOIN AnnotationPoints p ON p.AnnotationId = b.Id'''
    for sid, page, w, hgt, text, tc, fs, blob in db.execute(q):
        if sid not in songs or not text or not w or not hgt:
            continue
        x = y = 0.1
        if blob and len(blob) >= 16:
            x, y = struct.unpack('<2d', blob[:16])
            x, y = x / w, y / hgt
        pages.setdefault((sid, page), []).append(
            {'t': 'text', 'color': color(tc)[0], 'size': round((fs or 12) / hgt, 5),
             'x': round(x, 5), 'y': round(y, 5), 'text': text.strip()})

    for (sid, page), items in pages.items():
        song_id = songs[sid]['id']
        records.append({**base, 'id': f'ann:{song_id}:{page}', 'kind': 'ann', 'songId': song_id,
                        'page': page, 'items': items})

    records = list(songs.values()) + records
    with open(os.path.join(out, 'bibliotheque.json'), 'w') as o:
        json.dump({'source': os.path.basename(src), 'records': records}, o, ensure_ascii=False)
    os.unlink(tmp.name)
    kinds = {}
    for r in records:
        kinds[r['kind']] = kinds.get(r['kind'], 0) + 1
    print(f"{len(songs)} morceaux, {count} fichiers, {kinds.get('setlist', 0)} setlists, "
          f"{kinds.get('group', 0)} groupes, {kinds.get('ann', 0)} pages annotées")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
