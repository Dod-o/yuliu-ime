from pathlib import Path
import urllib.request,json,time
root = Path(__file__).resolve().parent.parent
key = (root/'work/local-key.txt').read_text().strip()
def req(route,body):
    r=urllib.request.Request('http://127.0.0.1:5000/'+route,json.dumps(body).encode(),{'Content-Type':'application/json','Authorization':'Bearer '+key})
    t=time.perf_counter()
    with urllib.request.urlopen(r,timeout=60) as response: result=json.load(response)
    return result,round((time.perf_counter()-t)*1000,1)
rows=[]
for keys in ['n','ni','nih','nihao','nihaoshijie']:
    result,ms=req('candidates',{'keys':keys})
    assert result['candidates'], keys
    row={'keys':keys,'ms':ms,'top':[c['word'] for c in result['candidates'][:5]]}
    rows.append(row); print(json.dumps(row,ensure_ascii=False))
result,ms=req('commit',{'text':'你好世界','new':True})
assert 'message' in result
print('commit OK',ms)
(root/'work/smoke-results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
