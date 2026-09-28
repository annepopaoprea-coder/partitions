#!/usr/bin/env python3
"""Partitions ↔ MuseScore bridge.

A small local service that lets the Partitions web app use MuseScore and
Audiveris installed on this computer. It listens on 127.0.0.1 only and
answers requests coming from the Partitions app (checked by the browser's
Origin header), never from other websites.

Jobs (convert a PDF, transpose, extract parts, change clef, figured bass)
run MuseScore / Audiveris from the command line. "Open in MuseScore" opens
the score in the MuseScore window; each save is converted back to PDF and
offered to the app, which updates the song in the library.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 47823
ALLOWED_ORIGINS = {
    'https://annepopaoprea-coder.github.io',
    'http://localhost:4173',
    'http://localhost:5173',
}
WORK = Path.home() / 'Documents' / 'Partitions MuseScore'
STATE = Path.home() / '.local' / 'state' / 'partitions-bridge'
ENV = {**os.environ, 'QT_QPA_PLATFORM': 'offscreen'}

jobs: dict[str, dict] = {}
edits: dict[str, dict] = {}  # songId -> {path, sent_mtime, version, pdf, mscz, title}
lock = threading.Lock()


def mscore() -> str | None:
    for name in ('mscore', 'mscore4', 'musescore', 'mscore4portable'):
        path = shutil.which(name)
        if path:
            return path
    return None


def run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=ENV)


def ms(*args: str, timeout: int = 600) -> subprocess.CompletedProcess:
    exe = mscore()
    if not exe:
        raise RuntimeError("MuseScore n'est pas installé")
    return run([exe, *args], timeout)


def safe_name(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', '-', title).strip()[:120] or 'Partition'


def convert(src: Path, dst: Path):
    r = ms('-o', str(dst), str(src))
    if not dst.exists():
        raise RuntimeError(f'Conversion MuseScore impossible : {r.stderr.strip()[-300:]}')


def result(files: list[tuple[Path, str | None, str]]) -> list[dict]:
    """Package produced files for the app: (path, role, label)."""
    return [{'name': p.name, 'role': role, 'label': label, 'data': base64.b64encode(p.read_bytes()).decode()} for p, role, label in files]


# ---- MusicXML edits ------------------------------------------------------

def to_musicxml(src: Path, tmp: Path) -> Path:
    out = tmp / 'score.musicxml'
    convert(src, out)
    return out


def musicxml_parts(xml: Path) -> list[tuple[str, str]]:
    root = ET.parse(xml).getroot()
    return [(sp.get('id'), (sp.findtext('part-name') or sp.get('id')).strip()) for sp in root.iter('score-part')]


CLEFS = {
    'G': ('G', '2', None),
    'G1': ('G', '1', None),
    'G8vb': ('G', '2', '-1'),
    'C1': ('C', '1', None),
    'C3': ('C', '3', None),
    'C4': ('C', '4', None),
    'F': ('F', '4', None),
}


def set_clef(xml: Path, part_id: str, clef: str, staff: str | None):
    """Change a part's clef everywhere; pitches stay, only the reading changes."""
    sign, line, octave = CLEFS[clef]
    tree = ET.parse(xml)
    for part in tree.getroot().iter('part'):
        if part.get('id') != part_id:
            continue
        for el in part.iter('clef'):
            if staff and el.get('number') not in (None, staff):
                continue
            for child in list(el):
                el.remove(child)
            ET.SubElement(el, 'sign').text = sign
            ET.SubElement(el, 'line').text = line
            if octave:
                ET.SubElement(el, 'clef-octave-change').text = octave
    tree.write(xml, encoding='utf-8', xml_declaration=True)


def strip_figures(xml: Path) -> int:
    tree = ET.parse(xml)
    removed = 0
    for parent in tree.getroot().iter():
        for fb in parent.findall('figured-bass'):
            parent.remove(fb)
            removed += 1
    tree.write(xml, encoding='utf-8', xml_declaration=True)
    return removed


def count_figures(xml: Path) -> int:
    return sum(1 for _ in ET.parse(xml).getroot().iter('figured-bass'))


# ---- Jobs ----------------------------------------------------------------

def job_omr(tmp: Path, src: Path, title: str, params: dict):
    exe = shutil.which('audiveris')
    if not exe:
        raise RuntimeError("Audiveris n'est pas installé")
    out = tmp / 'omr'
    out.mkdir()
    r = run([exe, '-batch', '-export', '-output', str(out), '--', str(src)], timeout=3600)
    mxl = sorted(out.rglob('*.mxl')) or sorted(out.rglob('*.musicxml'))
    if not mxl:
        raise RuntimeError('Audiveris n’a pas reconnu de musique dans ce document. ' + (r.stderr or r.stdout).strip()[-300:])
    # Audiveris writes one file per movement when it finds several: MuseScore opens the first.
    base = safe_name(title)
    mscz = tmp / f'{base}.mscz'
    pdf = tmp / f'{base}.pdf'
    convert(mxl[0], mscz)
    convert(mscz, pdf)
    note = f' ({len(mxl)} mouvements détectés, seul le premier est converti)' if len(mxl) > 1 else ''
    return result([(mscz, 'source', 'Partition MuseScore'), (pdf, None, 'Partition reconnue' + note)])


def job_transpose(tmp: Path, src: Path, title: str, params: dict):
    # MuseScore's own transposition keeps correct spelling and key signatures.
    options = {
        'mode': 'by_key' if 'key' in params else 'by_interval',
        'direction': params.get('direction', 'closest'),
        'targetKey': int(params.get('key', 0)),
        'transposeInterval': int(params.get('interval', 0)),
        'transposeKeySignatures': True,
        'transposeChordNames': True,
        'useDoubleAccidentals': False,
    }
    r = ms('--score-transpose', json.dumps(options), str(src))
    data = json.loads(r.stdout)
    blob = data.get('mscz') or data.get('scoreBin')
    if not blob:
        raise RuntimeError('Transposition impossible : ' + (r.stderr.strip()[-300:] or 'réponse inattendue de MuseScore'))
    label = params.get('label', 'transposé')
    base = safe_name(f'{title} ({label})')
    mscz = tmp / f'{base}.mscz'
    mscz.write_bytes(base64.b64decode(blob))
    pdf = tmp / f'{base}.pdf'
    convert(mscz, pdf)
    return result([(mscz, 'source', base), (pdf, None, base)])


def job_parts(tmp: Path, src: Path, title: str, params: dict):
    """One PDF (and MuseScore file) per instrument, via MusicXML."""
    xml = to_musicxml(src, tmp)
    parts = musicxml_parts(xml)
    if len(parts) < 2:
        raise RuntimeError('Cette partition ne contient qu’une seule partie.')
    files = []
    for pid, name in parts:
        tree = ET.parse(xml)
        root = tree.getroot()
        plist = root.find('part-list')
        for sp in list(plist):
            if sp.tag == 'score-part' and sp.get('id') != pid:
                plist.remove(sp)
            elif sp.tag == 'part-group':
                plist.remove(sp)
        for p in list(root.findall('part')):
            if p.get('id') != pid:
                root.remove(p)
        one = tmp / f'part-{pid}.musicxml'
        tree.write(one, encoding='utf-8', xml_declaration=True)
        base = safe_name(f'{title} — {name}')
        mscz = tmp / f'{base}.mscz'
        pdf = tmp / f'{base}.pdf'
        convert(one, mscz)
        convert(mscz, pdf)
        files += [(mscz, 'source', base), (pdf, None, base)]
    return result(files)


def job_clef(tmp: Path, src: Path, title: str, params: dict):
    xml = to_musicxml(src, tmp)
    parts = musicxml_parts(xml)
    part_id = params.get('part') or parts[0][0]
    set_clef(xml, part_id, params['clef'], params.get('staff'))
    label = params.get('label', 'autre clé')
    base = safe_name(f'{title} ({label})')
    mscz = tmp / f'{base}.mscz'
    pdf = tmp / f'{base}.pdf'
    convert(xml, mscz)
    convert(mscz, pdf)
    return result([(mscz, 'source', base), (pdf, None, base)])


def job_figures(tmp: Path, src: Path, title: str, params: dict):
    xml = to_musicxml(src, tmp)
    found = count_figures(xml)
    if not found:
        raise RuntimeError(
            "Cette partition ne contient pas de basse chiffrée. Ajoutez les chiffres dans MuseScore "
            "(sélectionner une note de basse puis Ctrl+G), puis réessayez.")
    show = params.get('show', True)
    if not show:
        strip_figures(xml)
    base = safe_name(f"{title} ({'avec' if show else 'sans'} basse chiffrée)")
    mscz = tmp / f'{base}.mscz'
    pdf = tmp / f'{base}.pdf'
    convert(xml, mscz)
    convert(mscz, pdf)
    return result([(mscz, 'source', base), (pdf, None, base)])


def job_render(tmp: Path, src: Path, title: str, params: dict):
    """A MuseScore or MusicXML file added to the library: engrave it to PDF."""
    base = safe_name(title)
    mscz = tmp / f'{base}.mscz'
    pdf = tmp / f'{base}.pdf'
    if src.suffix == '.mscz':
        shutil.copy(src, mscz)
    else:
        convert(src, mscz)
    convert(mscz, pdf)
    return result([(mscz, 'source', base), (pdf, None, base)])


def job_info(tmp: Path, src: Path, title: str, params: dict):
    """Parts and figured bass present in a score (to fill the app's menus)."""
    xml = to_musicxml(src, tmp)
    return {'parts': [{'id': i, 'name': n} for i, n in musicxml_parts(xml)], 'figures': count_figures(xml)}


JOBS = {'omr': job_omr, 'render': job_render, 'transpose': job_transpose, 'parts': job_parts, 'clef': job_clef, 'figures': job_figures, 'info': job_info}


def start_job(op: str, title: str, name: str, data: bytes, params: dict) -> str:
    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {'status': 'running', 'op': op, 'started': time.time()}

    def work():
        tmp = Path(tempfile.mkdtemp(prefix='partitions-'))
        try:
            src = tmp / ('input' + Path(name).suffix.lower())
            src.write_bytes(data)
            out = JOBS[op](tmp, src, title, params)
            jobs[job_id] = {'status': 'done', 'result': out}
        except Exception as e:  # reported to the app as a readable message
            jobs[job_id] = {'status': 'error', 'message': str(e)}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    threading.Thread(target=work, daemon=True).start()
    return job_id


# ---- Open in MuseScore and bring the saves back ---------------------------

def open_in_musescore(song_id: str, title: str, name: str, data: bytes):
    WORK.mkdir(parents=True, exist_ok=True)
    with lock:
        cur = edits.get(song_id)
    path = cur['path'] if cur else WORK / f'{safe_name(title)} [{song_id[:8]}]{Path(name).suffix.lower()}'
    if not cur or not path.exists():
        path.write_bytes(data)
    with lock:
        edits[song_id] = {'path': path, 'title': title, 'sent_mtime': path.stat().st_mtime, 'version': None}
    # The desktop launcher applies the screen scale (see ~/.local/bin/musescore).
    gui = Path.home() / '.local' / 'bin' / 'musescore'
    exe = str(gui) if gui.exists() else mscore()
    if not exe:
        raise RuntimeError("MuseScore n'est pas installé")
    env = {k: v for k, v in os.environ.items() if k != 'QT_QPA_PLATFORM'}
    subprocess.Popen([exe, str(path)], env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    save_state()


def watch_edits():
    """Convert each MuseScore save to PDF so the app can pick it up."""
    while True:
        time.sleep(2)
        with lock:
            items = list(edits.items())
        for song_id, e in items:
            path: Path = e['path']
            if not path.exists():
                continue
            mtime = path.stat().st_mtime
            if mtime <= e['sent_mtime'] or e.get('version') == mtime:
                continue
            if time.time() - mtime < 2:  # still being written
                continue
            try:
                tmp = Path(tempfile.mkdtemp(prefix='partitions-edit-'))
                src = path
                # MuseScore saves .mscz; a MusicXML we sent becomes .mscz on "Save as".
                mscz_path = path if path.suffix == '.mscz' else path.with_suffix('.mscz')
                if mscz_path.exists() and mscz_path.stat().st_mtime >= mtime:
                    src = mscz_path
                pdf = tmp / f"{safe_name(e['title'])}.pdf"
                convert(src, pdf)
                with lock:
                    e['version'] = mtime
                    e['pdf'] = pdf.read_bytes()
                    e['mscz'] = src.read_bytes()
                    e['mscz_name'] = src.name
                shutil.rmtree(tmp, ignore_errors=True)
            except Exception as ex:
                print('conversion après enregistrement impossible :', ex, flush=True)
                with lock:
                    e['version'] = mtime
                    e['error'] = str(ex)


def save_state():
    STATE.mkdir(parents=True, exist_ok=True)
    with lock:
        data = {k: {'path': str(v['path']), 'title': v['title'], 'sent_mtime': v['sent_mtime']} for k, v in edits.items()}
    (STATE / 'edits.json').write_text(json.dumps(data))


def load_state():
    try:
        data = json.loads((STATE / 'edits.json').read_text())
    except Exception:
        return
    for k, v in data.items():
        edits[k] = {'path': Path(v['path']), 'title': v['title'], 'sent_mtime': v['sent_mtime'], 'version': None}


# ---- HTTP ----------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'PartitionsBridge/1'

    def log_message(self, *args):
        pass

    def origin_ok(self) -> bool:
        return self.headers.get('Origin') in ALLOWED_ORIGINS

    def cors(self):
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Max-Age', '600')

    def reply(self, code: int, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204 if self.origin_ok() else 403)
        self.cors()
        self.end_headers()

    def body(self) -> dict:
        n = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if not self.origin_ok():
            return self.reply(403, {'error': 'origine refusée'})
        if self.path == '/status':
            v = None
            if mscore():
                r = run([mscore(), '--version'], timeout=30)
                v = (r.stdout or r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr) else 'installé'
            return self.reply(200, {'ok': True, 'musescore': v, 'audiveris': bool(shutil.which('audiveris'))})
        m = re.fullmatch(r'/jobs/([0-9a-f]+)', self.path)
        if m:
            job = jobs.get(m.group(1))
            if not job:
                return self.reply(404, {'error': 'tâche inconnue'})
            if job['status'] != 'running':
                jobs.pop(m.group(1), None)  # results are handed over once
            return self.reply(200, job)
        if self.path == '/edits':
            out = []
            with lock:
                for song_id, e in edits.items():
                    if e.get('pdf'):
                        out.append({
                            'songId': song_id,
                            'version': e['version'],
                            'pdf': base64.b64encode(e['pdf']).decode(),
                            'mscz': base64.b64encode(e['mscz']).decode(),
                            'msczName': e.get('mscz_name', 'partition.mscz'),
                        })
                    elif e.get('error'):
                        out.append({'songId': song_id, 'version': e['version'], 'error': e['error']})
            return self.reply(200, out)
        return self.reply(404, {'error': 'inconnu'})

    def do_POST(self):
        if not self.origin_ok():
            return self.reply(403, {'error': 'origine refusée'})
        try:
            b = self.body()
            if self.path == '/jobs':
                if b.get('op') not in JOBS:
                    return self.reply(400, {'error': 'opération inconnue'})
                job_id = start_job(b['op'], b.get('title', 'Partition'), b['name'], base64.b64decode(b['data']), b.get('params') or {})
                return self.reply(200, {'id': job_id})
            if self.path == '/edit':
                open_in_musescore(b['songId'], b.get('title', 'Partition'), b['name'], base64.b64decode(b['data']))
                return self.reply(200, {'ok': True})
            m = re.fullmatch(r'/edits/([\w-]+)/ack', self.path)
            if m:
                with lock:
                    e = edits.get(m.group(1))
                    if e and e.get('version') == b.get('version'):
                        e['sent_mtime'] = e['version']
                        e.pop('pdf', None)
                        e.pop('mscz', None)
                        e.pop('error', None)
                save_state()
                return self.reply(200, {'ok': True})
        except Exception as ex:
            return self.reply(500, {'error': str(ex)})
        return self.reply(404, {'error': 'inconnu'})


def main():
    load_state()
    threading.Thread(target=watch_edits, daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Pont Partitions ↔ MuseScore sur http://127.0.0.1:{PORT}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
