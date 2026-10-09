import json,time,urllib.request,statistics,concurrent.futures
from pathlib import Path
root=Path(__file__).resolve().parents[1];key=(root/'work/local-key.txt').read_text().strip()
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(route,data=None):
 req=urllib.request.Request('http://127.0.0.1:5000/api/'+route,None if data is None else json.dumps(data).encode(),{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 with opener.open(req,timeout=40) as r:return json.load(r)
cases=[
('','nihao','你好'),('','xiexie','谢谢'),('','shurufa','输入法'),('','moxing','模型'),('','shangxiawen','上下文'),('','diannao','电脑'),('','jintian','今天'),('','women','我们'),
('我想买一台新的','diannao','电脑'),('这个项目使用了一个更大的','moxing','模型'),('打字需要改进','shurufa','输入法'),('医生建议我按时吃','yao','药'),('他叉着自己的','yao','腰'),('他提出了新的','yijian','意见'),('我买了','yijian','一件'),('请帮我','chaxun','查询'),('我们需要提高输入法的','zhunquelv','准确率'),('这是一个非常重要的','wenti','问题'),
('明天早上我们一起去','gongyuan','公园'),('这段代码需要重新','bianyi','编译'),('请先打开浏览器，然后点击','lianjie','链接'),('我今天忘记带家里的','yaoshi','钥匙'),('这家餐厅的饭菜非常','haochi','好吃'),('请告诉我你的联系','fangshi','方式'),('我们应该保护自然','huanjing','环境'),('这次考试的成绩很','youxiu','优秀'),('文件上传失败，请稍后','chongshi','重试'),('请将这份文件保存到','zhuomian','桌面'),('电脑运行速度越来越','man','慢'),('今天下午可能会','xiayu','下雨'),('我每天坐地铁去','shangban','上班'),('这个软件的用户','tiyan','体验'),('我正在学习人工','zhineng','智能'),('这个数据库需要定期','beifen','备份'),('这个问题需要仔细','fenxi','分析'),('请稍等，正在加载','shuju','数据'),('他的身体十分','jiankang','健康'),('祝你生日','kuaile','快乐'),('我们应该保持','lianxi','联系'),('他昨天买了一部新','shouji','手机'),
('','nh','你好'),('我正在改进这个','srf','输入法'),('我正在改进这个','shurf','输入法'),('我们正在研究大','yymx','语言模型'),('','nihaoshijie','你好世界'),('我准备购买一台','diannao','电脑'),
('','shurfa','输入法'),('','diannoa','电脑'),('','xiexei','谢谢'),('','si','四'),('','shi','是'),('我去过',"xi'an",'西安')]
rows=[]
for before,keys,wanted in cases:
 start=time.perf_counter();r=api('candidates',{'keys':keys,'context':before,'session':'evaluation'});top=[c['word'] for c in r['candidates'][:5]]
 rows.append({'keys':keys,'context':before,'expected':wanted,'top':top,'top1':bool(top and top[0]==wanted),'top5':wanted in top,'ms':round((time.perf_counter()-start)*1000,1),'error':r.get('error')})
assert all(not x['error'] for x in rows),rows
# Real right-context comparison: same prefix and keys, different suffixes.
for after,expected_suffix in [('可以缓解症状。','药'),('部受伤了。','腰')]:
 r=api('candidates',{'keys':'yao','context':'他的','after':after,'session':'evaluation'});rows.append({'suffix':after,'top':[c['word'] for c in r['candidates'][:5]],'error':r.get('error')});assert r['candidates'][0]['word']==expected_suffix,r
# A rapid input sequence must leave the final job correct; superseded jobs finish without polluting it.
first=[]
for k in ['s','sh','shu','shur','shuru','shuruf','shurufa']:
 t=time.perf_counter();r=api('candidates',{'keys':k,'context':'','progressive':True,'session':'rapid'});first.append(round((time.perf_counter()-t)*1000,1))
final=api('results/'+r['job']+'?wait=1');assert final['candidates'][0]['word']=='输入法',final
# Repeated completed request uses the exact result cache.
t=time.perf_counter();cached=api('candidates',{'keys':'shurufa','context':'','progressive':True,'session':'rapid'});cache_ms=round((time.perf_counter()-t)*1000,1);assert cached['job']==r['job']
api('candidates',{'keys':'nihao','context':'','progressive':True,'session':'rapid'})
returned=api('candidates',{'keys':'shurufa','context':'','progressive':True,'session':'rapid'});assert returned['job']==r['job'],'completed results must survive intervening input'

# Local learning APIs persist explicit selection and support removal/undo/pause.
snapshot=api('learning');api('commit',{'text':'测试专词','context':'','keys':'ceshizhuanci','selected':True});learned=api('learning');entry=next(e for e in learned['entries'] if e['word']=='测试专词');api('learning',{'action':'remove','id':entry['id']});assert not any(e['id']==entry['id'] for e in api('learning')['entries']);api('learning',{'action':'undo'});assert any(e['id']==entry['id'] for e in api('learning')['entries']);api('learning',{'action':'remove','id':entry['id']});api('learning',{'action':'pause'});api('commit',{'text':'暂停专词','keys':'zantingzhuanci','selected':True});assert not any(e['word']=='暂停专词' for e in api('learning')['entries']);api('learning',{'action':'resume' if snapshot['enabled'] else 'pause'})
regular=rows[:40];extra=rows[40:len(cases)]
result={'regular':{'top1':sum(x['top1'] for x in regular),'top5':sum(x['top5'] for x in regular),'count':len(regular)},'extra':{'top1':sum(x['top1'] for x in extra),'top5':sum(x['top5'] for x in extra),'count':len(extra)},'rapid_first_ms':first,'cache_ms':cache_ms,'learning_checks':True,'rows':rows}
(root/'work/advanced-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:v for k,v in result.items() if k!='rows'},ensure_ascii=False));print('misses',json.dumps([r for r in regular+extra if not r['top1']],ensure_ascii=False))
