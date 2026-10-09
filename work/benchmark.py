from pathlib import Path
import json,time,urllib.request
root=Path(__file__).resolve().parent.parent
key=(root/'work/local-key.txt').read_text().strip()
records=[]
def call(route,body,label):
    r=urllib.request.Request('http://127.0.0.1:5000/'+route,json.dumps(body).encode(),{'Content-Type':'application/json','Authorization':'Bearer '+key})
    started=time.perf_counter()
    with urllib.request.urlopen(r,timeout=120) as response: result=json.load(response)
    row={'label':label,'route':route,'body':body,'client_ms':round((time.perf_counter()-started)*1000,1),'top':[c['word'] for c in result.get('candidates',[])[:3]]}
    records.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    return result
for attempt in range(40):
    try:
        urllib.request.urlopen('http://127.0.0.1:5000/',timeout=2).close();break
    except Exception:time.sleep(1)
else:raise RuntimeError('Server not ready')
for keys in ['n','ni',"ni'h","ni'ha",'nihao','nihaoshijie']:
    call('candidates',{'keys':keys},'typing')
for keys in ['nihaoshijie','nihaoshi','nihao','nihaoshijie']:
    call('candidates',{'keys':keys},'repeat/backspace')
call('commit',{'text':'今天天气','new':True},'commit')
for keys in ['z','zen','zenme','zenmeyang']:
    call('candidates',{'keys':keys},'immediate-after-commit')
(root/'work/benchmark-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
