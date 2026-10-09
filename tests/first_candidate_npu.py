"""Cold context must release candidates before optional lookahead finishes."""
import json
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
key = (root / 'work/local-key.txt').read_text().strip()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def api(route, data=None):
    request = urllib.request.Request(
        'http://127.0.0.1:5000/api/' + route,
        None if data is None else json.dumps(data).encode(),
        {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with opener.open(request, timeout=40) as response:
        return json.load(response)

start = time.perf_counter()
reply = api('candidates', {'keys': 'yao', 'context':
    ('测试首次候选交回时机，医生建议按时吃药。' * 20)[-240:] + str(time.time_ns()),
    'after': '可以缓解症状。', 'progressive': True, 'session': 'first-candidate-test'})
first = api('results/' + reply['job'] + '?first=1')
first_ms = (time.perf_counter() - start) * 1000
assert first['candidates'] and not first.get('error'), first
assert first['pending'], 'First candidates waited for the entire search'
final = api('results/' + reply['job'] + '?wait=1')
complete_ms = (time.perf_counter() - start) * 1000
assert final['candidates'] and not final.get('error') and not final['pending'], final
print(json.dumps({'first_candidates_ms': round(first_ms, 1),
                  'complete_ms': round(complete_ms, 1)}))
