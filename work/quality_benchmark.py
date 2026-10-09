import json,time,urllib.request,sys
from pathlib import Path
root=Path.cwd();key=(root/'work/local-key.txt').read_text().strip()
def api(route,data):
 req=urllib.request.Request('http://127.0.0.1:5000/api/'+route,json.dumps(data).encode(),{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
cases=[('','nihao','你好'),('','xiexie','谢谢'),('','shurufa','输入法'),('','moxing','模型'),('','shangxiawen','上下文'),('','diannao','电脑'),('','jintian','今天'),('','women','我们'),('我想买一台新的','diannao','电脑'),('这个项目使用了一个更大的','moxing','模型'),('打字需要改进','shurufa','输入法'),('医生建议我按时吃','yao','药'),('他叉着自己的','yao','腰'),('他提出了新的','yijian','意见'),('我买了','yijian','一件'),('请帮我','chaxun','查询'),('我们需要提高输入法的','zhunquelv','准确率'),('这是一个非常重要的','wenti','问题')]
rows=[]
for context,keys,expected in cases:
 api('context',{'text':context});t=time.perf_counter();r=api('candidates',{'keys':keys,'context':context});top=[c['word'] for c in r['candidates'][:5]]
 rows.append({'context':context,'keys':keys,'expected':expected,'top':top,'top1':bool(top and top[0]==expected),'top5':expected in top,'ms':round((time.perf_counter()-t)*1000,1)})
result={'label':sys.argv[1],'top1':sum(r['top1'] for r in rows),'top5':sum(r['top5'] for r in rows),'count':len(rows),'rows':rows}
(root/('work/quality-'+sys.argv[1]+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False))
