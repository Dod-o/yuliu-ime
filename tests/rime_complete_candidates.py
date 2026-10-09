"""Multi-token input must expose complete candidates without Tab or Space."""
import ctypes as C
import json
import time
from pathlib import Path

root = Path.cwd()
exec((root / 'work/test_rime_npu.py').read_text(encoding='utf-8').split('results=[]')[0])
try:
    rows = []
    for keys, expected in [('xiaolanghao', '小狼'), ('nihaoshijie', '你好'), ('zenmeyang', '怎么样')]:
        lib.RimeClearComposition(session)
        start = time.perf_counter()
        for char in keys:
            lib.RimeProcessKey(session, ord(char), 0)
        ctx = initialized(Context)
        assert lib.RimeGetContext(session, C.byref(ctx))
        words = [ctx.menu.candidates[i].text.decode() for i in range(min(5, ctx.menu.num_candidates))]
        shown = (ctx.composition.preedit or b'').decode()
        lib.RimeFreeContext(C.byref(ctx))
        assert shown == keys and words and words[0].startswith(expected), (keys, shown, words)
        if keys == 'xiaolanghao':
            assert '效率' not in words
        rows.append({'keys': keys, 'top': words, 'sequence_ms': round((time.perf_counter()-start)*1000, 1)})
    print(json.dumps(rows, ensure_ascii=False))
finally:
    lib.RimeDestroySession(session)
    lib.RimeFinalize()
