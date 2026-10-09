import json,urllib.request,time,ctypes as C
from pathlib import Path
root=Path.cwd()
# Initialize actual Rime DLL and the deployed Lua module without desktop input.
exec((root/'work/test_rime_npu.py').read_text(encoding='utf-8').split('results=[]')[0])
key=(root/'work/local-key.txt').read_text().strip()
def api(route,data=None):
 req=urllib.request.Request('http://127.0.0.1:5000/api/'+route,None if data is None else json.dumps(data).encode(),{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
lib.RimeSelectCandidate.argtypes=[C.c_size_t,C.c_size_t];lib.RimeCommitComposition.argtypes=[C.c_size_t]
results=[]
for chunks in [[('yisheng','医生'),('jianyi','建议'),('wo','我'),('meitian','每天'),('anshi','按时'),('chi','吃')],[('ta','他'),('cha','叉'),('zhe','着'),('ziji','自己'),('de','的')]]:
 lib.RimeDestroySession(session);session=lib.RimeCreateSession();assert lib.RimeSelectSchema(session,b'llm')
 paragraph=''
 for keys,text in chunks:
  for char in keys:assert lib.RimeProcessKey(session,ord(char),0)
  # Same candidate order as the native translator, which supplies its own context.
  choices=api('candidates',{'keys':keys,'context':paragraph})['candidates']
  index=next(i for i,c in enumerate(choices) if c['word']==text and c['consumedkeys']==len(keys))
  assert lib.RimeSelectCandidate(session,index)
  lib.RimeCommitComposition(session)
  result=initialized(Commit);assert lib.RimeGetCommit(session,C.byref(result));actual=result.text.decode();lib.RimeFreeCommit(C.byref(result));assert actual==text,(actual,text)
  paragraph+=text
  snapshot=api('userdata');assert snapshot['committedContext']==paragraph,(snapshot['committedContext'],paragraph)
  results.append({'commit':text,'context':snapshot['committedContext']})
 for char in 'yao':lib.RimeProcessKey(session,ord(char),0)
 context=initialized(Context);lib.RimeGetContext(session,C.byref(context));top=[context.menu.candidates[i].text.decode() for i in range(context.menu.num_candidates)];lib.RimeFreeContext(C.byref(context))
 expected='药' if paragraph.endswith('吃') else '腰';assert top[0]==expected,(paragraph,top)
 results.append({'paragraph':paragraph,'keys':'yao','top':top})
 # A different frontend must not contaminate the Rime paragraph.
 api('context',{'text':'软件开发的 API 接口'})
 lib.RimeClearComposition(session)
 for char in 'yao':lib.RimeProcessKey(session,ord(char),0)
 context=initialized(Context);lib.RimeGetContext(session,C.byref(context));actual=context.menu.candidates[0].text.decode();lib.RimeFreeContext(C.byref(context));assert actual==expected
 results.append({'web_context_isolation':True,'first':actual})
lib.RimeDestroySession(session);lib.RimeFinalize()
(root/'work/rime-short-context-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False,indent=2))
