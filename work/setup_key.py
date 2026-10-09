from pathlib import Path
import secrets, hashlib
root = Path(__file__).resolve().parent.parent
keyfile = root / 'work/local-key.txt'
if not keyfile.exists():
    keyfile.write_text(secrets.token_urlsafe(32), encoding='utf-8')
key = keyfile.read_text().strip()
(root / 'lime/key.txt').write_text(hashlib.sha256(key.encode()).hexdigest()+'\n')
