import ctypes as C,os,json,time,shutil
from pathlib import Path
root=Path.cwd();package=root/'work/weasel-all';user=root/'work/rime-test';shutil.copytree(root/'outputs/rime-npu',user,dirs_exist_ok=True)
os.add_dll_directory(str(package));lib=C.CDLL(str(package/'rime.dll'))
class Traits(C.Structure):
 _fields_=[('data_size',C.c_int)]+[(n,C.c_char_p) for n in ['shared_data_dir','user_data_dir','distribution_name','distribution_code_name','distribution_version','app_name']]+[('modules',C.c_void_p),('min_log_level',C.c_int)]+[(n,C.c_char_p) for n in ['log_dir','prebuilt_data_dir','staging_dir']]
class Composition(C.Structure):_fields_=[(n,C.c_int) for n in ['length','cursor_pos','sel_start','sel_end']]+[('preedit',C.c_char_p)]
class Candidate(C.Structure):_fields_=[('text',C.c_char_p),('comment',C.c_char_p),('reserved',C.c_void_p)]
class Menu(C.Structure):_fields_=[(n,C.c_int) for n in ['page_size','page_no','is_last_page','highlighted_candidate_index','num_candidates']]+[('candidates',C.POINTER(Candidate)),('select_keys',C.c_char_p)]
class Context(C.Structure):_fields_=[('data_size',C.c_int),('composition',Composition),('menu',Menu),('commit_text_preview',C.c_char_p),('select_labels',C.c_void_p)]
class Commit(C.Structure):_fields_=[('data_size',C.c_int),('text',C.c_char_p)]
def initialized(cls):
 obj=cls();obj.data_size=C.sizeof(cls)-C.sizeof(C.c_int);return obj
traits=initialized(Traits);traits.shared_data_dir=str(package/'data').encode();traits.user_data_dir=str(user).encode();traits.app_name=b'rime.nputest';traits.log_dir=b''
lib.RimeSetup(C.byref(traits));lib.RimeInitialize(C.byref(traits));lib.RimeStartMaintenance(1);lib.RimeJoinMaintenanceThread()
lib.RimeCreateSession.restype=C.c_size_t
session=lib.RimeCreateSession()
for name in ['RimeSelectSchema','RimeProcessKey','RimeGetContext','RimeClearComposition','RimeGetCommit','RimeDestroySession']:
 getattr(lib,name).argtypes=[C.c_size_t]+{'RimeSelectSchema':[C.c_char_p],'RimeProcessKey':[C.c_int,C.c_int],'RimeGetContext':[C.POINTER(Context)],'RimeGetCommit':[C.POINTER(Commit)]}.get(name,[])
assert lib.RimeSelectSchema(session,b'llm')
results=[]
for keys in ['nihao','nihaoshijie','zenmeyang']:
 lib.RimeClearComposition(session)
 for key in keys:
  start=time.perf_counter();lib.RimeProcessKey(session,ord(key),0);ms=(time.perf_counter()-start)*1000
  context=initialized(Context);lib.RimeGetContext(session,C.byref(context))
  top=[context.menu.candidates[i].text.decode() for i in range(min(5,context.menu.num_candidates))]
  results.append({'key':key,'ms':round(ms,1),'top':top});lib.RimeFreeContext(C.byref(context))
lib.RimeProcessKey(session,32,0)
commit=initialized(Commit);lib.RimeGetCommit(session,C.byref(commit));print('commit',commit.text)
assert commit.text and commit.text.decode()=='怎么样'
assert results[4]['top'][0]=='你好' and results[15]['top'][0]=='你好世界'
if commit.text:lib.RimeFreeCommit(C.byref(commit))
lib.RimeDestroySession(session);lib.RimeFinalize()
(root/'work/rime-npu-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False,indent=2))
assert results[-1]['top'],'Rime Lua produced no candidates'
