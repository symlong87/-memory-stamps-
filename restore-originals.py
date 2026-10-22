"""Restore the three original PNGs and verify every byte with SHA-256."""
import hashlib
import json
import os
from pathlib import Path


def restore():
    root = Path(__file__).resolve().parent
    backup = root / 'backup-originals'
    manifest = json.loads((backup / 'manifest.json').read_text('utf-8'))
    allowed = {'dist/assets/gulangyu.png', 'dist/assets/tianjin-eye.png', 'dist/assets/xiaomai-island.png'}
    if {entry['path'] for entry in manifest} != allowed:
        raise ValueError('Original image manifest is invalid')
    pending = []
    for entry in manifest:
        target = root / entry['path']
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != entry['sha256']:
                raise ValueError(f'{target.name} already exists with different contents; move it aside before restoring')
            continue
        chunks = []
        for name in entry['parts']:
            if Path(name).name != name:
                raise ValueError('Invalid backup part path')
            chunks.append((backup / name).read_bytes())
        data = b''.join(chunks)
        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError(f'Backup verification failed: {target.name}')
        pending.append((target, data))
    for target, data in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.restoring')
        temporary.write_bytes(data)
        os.replace(temporary, target)
    launcher = root / '打开邮册.command'
    if launcher.exists():
        launcher.chmod(launcher.stat().st_mode | 0o100)
    print('原图校验通过，三张 PNG 已完整还原。')


if __name__ == '__main__':
    restore()
