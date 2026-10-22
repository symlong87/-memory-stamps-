"""Local album: serves the site and stores personal stamps beside the project."""
import argparse
import base64
import json
import os
import re
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DATA = ROOT / '.local-data'
LOCK = threading.Lock()


def read_collection():
    path = DATA / 'collection.json'
    return json.loads(path.read_text('utf-8')) if path.exists() else {'stamps': [], 'edits': []}


def write_collection(value):
    DATA.mkdir(exist_ok=True)
    temporary = DATA / 'collection.tmp'
    temporary.write_text(json.dumps(value, ensure_ascii=False), 'utf-8')
    os.replace(temporary, DATA / 'collection.json')


class AlbumHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'dist'), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def reply(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get('Host') not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
            self.send_error(403)
            return
        path = urlsplit(self.path).path
        if path == '/api/collection':
            try:
                with LOCK:
                    self.reply(200, dict(read_collection(), storage='disk'))
            except (OSError, ValueError):
                self.reply(500, {'error': '无法读取本地邮册，请检查 .local-data 文件夹。'})
        elif path.startswith('/personal-images/'):
            name = path.removeprefix('/personal-images/')
            if not re.fullmatch(r'[a-zA-Z0-9-]+\.(png|jpg|webp)', name):
                self.send_error(404)
                return
            file = DATA / 'images' / name
            if not file.is_file():
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', {'png': 'image/png', 'jpg': 'image/jpeg', 'webp': 'image/webp'}[file.suffix[1:]])
            self.send_header('Content-Length', str(file.stat().st_size))
            self.end_headers()
            self.wfile.write(file.read_bytes())
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != '/api/collection':
            self.send_error(404)
            return
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}') or (origin and origin != 'http://' + host):
            self.reply(403, {'error': '请从本地邮册页面操作。'})
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.reply(415, {'error': '请求格式不正确。'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 210 * 1024 * 1024:
                raise ValueError('这一批图片过大，请分批添加。')
            body = json.loads(self.rfile.read(size))
            with LOCK:
                current = read_collection()
                if body.get('operation') == 'add':
                    records = body['records']
                    if not isinstance(records, list) or not 1 <= len(records) <= 30:
                        raise ValueError('每批可添加 1 到 30 枚邮票。')
                    prepared = []
                    for record in records:
                        if not re.fullmatch(r'personal-[a-zA-Z0-9-]+', record['id']):
                            raise ValueError('邮票编号不正确。')
                        data_url = record.pop('dataURL')
                        header, encoded = data_url.split(',', 1)
                        ext = {'data:image/png;base64': 'png', 'data:image/jpeg;base64': 'jpg', 'data:image/webp;base64': 'webp'}.get(header)
                        if not ext:
                            raise ValueError('请选择 JPG、PNG 或 WebP 图片。')
                        image = base64.b64decode(encoded, validate=True)
                        if len(image) > 15 * 1024 * 1024:
                            raise ValueError('每张图片最大 15 MB。')
                        name = record['id'] + '.' + ext
                        record.update(image='/personal-images/' + name, original='/personal-images/' + name, extension=ext)
                        prepared.append((record, name, image))
                    (DATA / 'images').mkdir(parents=True, exist_ok=True)
                    ids = {r['id'] for r in current['stamps']}
                    for record, name, image in prepared:
                        if record['id'] not in ids:
                            (DATA / 'images' / name).write_bytes(image)
                            current['stamps'].append(record)
                            ids.add(record['id'])
                elif body.get('operation') == 'edit':
                    patch = body['patch']
                    if not isinstance(patch.get('id'), str):
                        raise ValueError('邮票编号不正确。')
                    existing = next((r for r in current['edits'] if r['id'] == patch['id']), None)
                    if existing is None:
                        current['edits'].append(patch)
                    else:
                        existing.update(patch)
                else:
                    raise ValueError('操作不正确。')
                write_collection(current)
                self.reply(200, dict(current, storage='disk'))
        except (ValueError, KeyError, TypeError) as error:
            self.reply(400, {'error': str(error)})
        except OSError:
            self.reply(500, {'error': '无法写入本地邮册，请检查磁盘空间和文件夹权限。'})


if __name__ == '__main__':
    recovery = ROOT / 'restore-originals.py'
    if recovery.exists():
        import runpy
        runpy.run_path(str(recovery), run_name='__main__')
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), AlbumHandler)
    except OSError:
        print(f'端口 {args.port} 正在使用。请关闭旧的本地服务器后重新打开邮册。')
        raise SystemExit(1)
    url = f'http://127.0.0.1:{args.port}/'
    print(f'记忆邮票：{url}\n新增图片、描述和移除记录保存在 {DATA}', flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
