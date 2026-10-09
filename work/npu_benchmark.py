import os,json,time,logging,sys,traceback
from pathlib import Path
os.environ['GENIEX_LOG']='INFO'
logging.basicConfig(level=logging.INFO)
from geniex import AutoModelForCausalLM,get_runtime_list,get_compute_unit_list,init
root=Path(__file__).resolve().parent.parent
mode=sys.argv[1] if len(sys.argv)>1 else 'hybrid'
result={'mode':mode,'model':'Qwen3-0.6B-Q4_0.gguf','tests':[]}
model=None
try:
    init()
    result['runtimes']={p:get_compute_unit_list(p) for p in get_runtime_list()}
    print(json.dumps(result),flush=True)
    started=time.perf_counter()
    model=AutoModelForCausalLM.from_pretrained(str(root/'models/Qwen3-0.6B-Q4_0.gguf'),device_map='llama_cpp:'+mode,n_ctx=512,n_threads=4,n_threads_batch=4)
    result['load_ms']=round((time.perf_counter()-started)*1000,1)
    for fixture in json.loads((root/'work/token-fixtures.json').read_text(encoding='utf-8')):
        for repeat in range(3):
            started=time.perf_counter()
            rows=model.forward_logits(fixture['tokens'])
            elapsed=(time.perf_counter()-started)*1000
            assert len(rows)==1 and len(rows[0])>100000
            row={'text':fixture['text'],'input_tokens':len(fixture['tokens']),'repeat':repeat,'ms':round(elapsed,1),'vocab_size':len(rows[0]),'top_ids':sorted(range(len(rows[0])),key=rows[0].__getitem__,reverse=True)[:5]}
            result['tests'].append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
except Exception as e:
    result['error']=str(e);traceback.print_exc()
finally:
    if model:model.close()
    (root/f'work/npu-benchmark-{mode}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
if 'error' in result:sys.exit(1)
