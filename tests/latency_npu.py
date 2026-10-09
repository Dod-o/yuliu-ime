import json,time,urllib.request,statistics
from pathlib import Path
root=Path(__file__).resolve().parents[1];key=(root/'work/local-key.txt').read_text().strip()
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(route,data=None):
 req=urllib.request.Request('http://127.0.0.1:5000/api/'+route,None if data is None else json.dumps(data).encode(),{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 with opener.open(req,timeout=40) as r:return json.load(r)
rows=[]
for chars in [0,128,256,400]:
 context=('今天我们讨论了如何改进这个软件的输入体验。'*30)[-max(chars-10,0):]+'医生建议我按时吃' if chars else ''
 context=context[-chars:] if chars else ''
 session='latency-'+str(chars);t=time.perf_counter();r=api('candidates',{'keys':'yao','context':context,'progressive':True,'session':session});initial=round((time.perf_counter()-t)*1000,1);first_count=len(r['candidates']);final=api('results/'+r['job']+'?wait=1');total=round((time.perf_counter()-t)*1000,1);assert final['candidates'] and not final.get('error'),final
 cached=[]
 for _ in range(5):
  t=time.perf_counter();c=api('candidates',{'keys':'yao','context':context,'progressive':True,'session':session});cached.append((time.perf_counter()-t)*1000)
 rows.append({'provided_context_chars':len(context),'initial_ms':initial,'initial_candidates':first_count,'complete_ms':total,'cached_median_ms':round(statistics.median(cached),1),'top':final['candidates'][0]['word']})
# State window is bounded to the most recent 256 Unicode characters.
api('context',{'text':'𠮷'*400});state=api('userdata');assert state['contextChars']==256 and len(state['committedContext'])==256
(root/'work/latency-results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(rows,ensure_ascii=False))
