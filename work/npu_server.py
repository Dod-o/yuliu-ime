import os,json,time,array,logging
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
from collections import OrderedDict
os.environ['GENIEX_LOG']='INFO'
logging.basicConfig(level=logging.INFO)
from geniex import AutoModelForCausalLM
root=Path(__file__).resolve().parent.parent
key=(root/'work/local-key.txt').read_text().strip()
model_name=os.environ.get('LIME_MODEL','Qwen3-1.7B-Q4_0.gguf')
print('Loading NPU model: '+model_name,flush=True)
model=AutoModelForCausalLM.from_pretrained(str(root/'models'/model_name),device_map='llama_cpp:npu',n_ctx=512,n_threads=4,n_threads_batch=4)
cache=OrderedDict()
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  if self.headers.get('Authorization')!='Bearer '+key: self.send_error(401);return
  try:
   tokens=json.loads(self.rfile.read(int(self.headers['Content-Length'])))['tokens']
   if not tokens or len(tokens)>512: raise ValueError('Expected 1..512 tokens')
   prefix=tuple(tokens);start=time.perf_counter();hit=prefix in cache
   if hit: data=cache[prefix];cache.move_to_end(prefix)
   else:
    data=array.array('f',model.forward_logits(tokens)[0]).tobytes();cache[prefix]=data
    if len(cache)>64:cache.popitem(last=False)
   ms=round((time.perf_counter()-start)*1000,2)
   print(json.dumps({'device':'HTP0','tokens':len(tokens),'ms':ms,'cache':hit}),flush=True)
   self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  except Exception as e:self.send_error(500,str(e))
print('NPU bridge ready on 127.0.0.1:5001',flush=True)
HTTPServer(('127.0.0.1',5001),Handler).serve_forever()
