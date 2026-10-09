"""Candidate completion/correction must never rewrite the displayed input."""
import ctypes as C
import json
import time
from pathlib import Path

root = Path.cwd()
exec((root / 'work/test_rime_npu.py').read_text(encoding='utf-8').split('results=[]')[0])
try:
    rows = []
    for keys in ['xiaolanghao', 'xiaolonghao', 'niha', 'nihap', "xi'an"]:
        lib.RimeClearComposition(session)
        for index, char in enumerate(keys):
            lib.RimeProcessKey(session, ord(char), 0)
            ctx = initialized(Context)
            assert lib.RimeGetContext(session, C.byref(ctx))
            shown = (ctx.composition.preedit or b'').decode()
            lib.RimeFreeContext(C.byref(ctx))
            assert shown == keys[:index + 1], (keys, index, shown)
        for refresh in [False, True]:
            if refresh:
                lib.RimeProcessKey(session, 0xff09, 0)
            ctx = initialized(Context)
            assert lib.RimeGetContext(session, C.byref(ctx))
            shown = (ctx.composition.preedit or b'').decode()
            lib.RimeFreeContext(C.byref(ctx))
            assert shown == keys, (keys, shown, refresh)
            rows.append({'input': keys, 'display': shown, 'refresh': refresh})
    print(json.dumps(rows))
finally:
    lib.RimeDestroySession(session)
    lib.RimeFinalize()
