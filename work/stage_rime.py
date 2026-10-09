from pathlib import Path
import os,shutil,time
root=Path.cwd();src=root/'outputs/rime-npu';dest=Path(os.environ['APPDATA'])/'Rime';dest.mkdir(exist_ok=True)
for rel in ['llm.schema.yaml','lua/json.lua','lua/fetch_text.lua','lua/llm_pinyin.lua']:
 target=dest/rel;target.parent.mkdir(exist_ok=True)
 if target.exists():shutil.copy(target,root/'work'/('rime-backup-'+str(int(time.time()))+'-'+target.name))
 shutil.copy(src/rel,target)
p=dest/'default.custom.yaml'
if not p.exists():shutil.copy(src/'default.custom.yaml',p)
else:print('Existing schema preferences preserved; add llm manually')
print('Rime schema staged:',dest)
