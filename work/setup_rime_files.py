from pathlib import Path
import shutil
root=Path(__file__).resolve().parent.parent
key=(root/'work/local-key.txt').read_text().strip()
source=root/'lime/rime';dest=root/'outputs/rime-npu'
for file in source.rglob('*'):
 if file.is_file():
  target=dest/file.relative_to(source);target.parent.mkdir(parents=True,exist_ok=True)
  target.write_text(file.read_text(encoding='utf-8-sig').replace('__LOCAL_KEY__',key),encoding='utf-8')
print('Generated local Rime configuration (contains local access key).')
