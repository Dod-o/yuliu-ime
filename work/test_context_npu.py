import json,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parent.parent
key=(root/'work/local-key.txt').read_text().strip()
def api(route,data):
 req=urllib.request.Request('http://127.0.0.1:5000/api/'+route,json.dumps(data).encode(),{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)
tests=[]
for context,keys in [('我饿了，想吃点','mian'),('请翻到下一','mian'),('这个理论需要通过实验来','zhengming'),('我觉得可以先试一','shi'),('医生建议我每天按时吃','yao'),('他叉着自己的','yao'),('他对这件事提出了新的','yijian')]:
 api('context',{'text':context});start=time.perf_counter();r=api('candidates',{'keys':keys})
 tests.append({'context':context,'keys':keys,'ms':round((time.perf_counter()-start)*1000,1),'top':[c['word'] for c in r['candidates'][:8]]})
expected={'这个理论需要通过实验来':'证明','我觉得可以先试一':'试','医生建议我每天按时吃':'药','他叉着自己的':'腰','他对这件事提出了新的':'意见'}
for test in tests:
 if test['context'] in expected: assert test['top'][0]==expected[test['context']],test
print(json.dumps(tests,ensure_ascii=False,indent=2))
(root/'work/context-npu-tests.json').write_text(json.dumps(tests,ensure_ascii=False,indent=2),encoding='utf-8')
api('context',{'text':''})
