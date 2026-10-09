"""Space commits the visible candidate without waiting for suffix scoring."""
import ctypes as C
import json
import time
from pathlib import Path

root = Path.cwd()
exec((root / 'work/test_rime_npu.py').read_text(encoding='utf-8').split('results=[]')[0])
try:
    (user / 'context.json').write_text(json.dumps({
        'before': ('这是短词输入延迟测试。' * 25)[-220:] + str(time.time_ns()) + '医生建议我按时吃',
        'after': '可以缓解症状。', 'docId': 'space-latency', 'supported': True,
        'timestamp': int(time.time() * 1000)}), encoding='utf-8')
    timings = []
    for char in 'yao':
        start = time.perf_counter()
        lib.RimeProcessKey(session, ord(char), 0)
        timings.append(round((time.perf_counter() - start) * 1000, 1))
    ctx = initialized(Context)
    assert lib.RimeGetContext(session, C.byref(ctx)) and ctx.menu.num_candidates
    selected = ctx.menu.candidates[ctx.menu.highlighted_candidate_index].text.decode()
    lib.RimeFreeContext(C.byref(ctx))
    start = time.perf_counter()
    lib.RimeProcessKey(session, 32, 0)
    space_ms = (time.perf_counter() - start) * 1000
    commit = initialized(Commit)
    assert lib.RimeGetCommit(session, C.byref(commit))
    committed = commit.text.decode()
    lib.RimeFreeCommit(C.byref(commit))
    assert committed == selected, (selected, committed)
    assert space_ms < 500, f'Space blocked on background inference: {space_ms:.1f} ms'
    print(json.dumps({'letter_ms': timings, 'space_ms': round(space_ms, 1), 'selected': selected}, ensure_ascii=False))
finally:
    lib.RimeDestroySession(session)
    lib.RimeFinalize()
