import ctypes as C,json,time
from pathlib import Path
root=Path.cwd()
exec((root/'work/test_rime_npu.py').read_text(encoding='utf-8').split('results=[]')[0])
def snapshot(before,after='',doc='test-doc',supported=True,old=False):
 (user/'context.json').write_text(json.dumps({'before':before,'after':after,'docId':doc,'supported':supported,'timestamp':int(time.time()*1000)-(10000 if old else 0)}),encoding='utf-8')
def top(keys):
 lib.RimeClearComposition(session)
 for char in keys:lib.RimeProcessKey(session,ord(char),0)
 lib.RimeProcessKey(session,0xff09,0)
 ctx=initialized(Context);lib.RimeGetContext(session,C.byref(ctx));words=[ctx.menu.candidates[i].text.decode() for i in range(ctx.menu.num_candidates)];lib.RimeFreeContext(C.byref(ctx));return words
rows=[]
for text,expected in [('医生建议我每天按时吃','药'),('他叉着自己的','腰'),('医生建议我每天按时吃','药')]:
 snapshot(text);words=top('yao');assert words[0]==expected,(text,words);rows.append({'document':text,'top':words})
# Switching to an unsupported field must clear the previous document's history.
snapshot('',doc='new-field',supported=False);words=top('nihao');assert words[0]=='你好',words;rows.append({'unsupported_new_field':words})
# An expired snapshot cannot supply a medicine context.
snapshot('医生建议我每天按时吃',doc='expired',old=True);words=top('yao');assert words[0]!='药',words;rows.append({'expired_ignored':words})
lib.RimeDestroySession(session);lib.RimeFinalize();(user/'context.json').unlink();(root/'work/rime-document-results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(rows,ensure_ascii=False))
