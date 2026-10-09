local json=require('json')
local fetch_text=require('fetch_text')
local translator,processor={},{}
local function request(route,body)
 local code,reply=fetch_text('http://127.0.0.1:5000/api/'..route,{source=json.encode(body),key='__LOCAL_KEY__'})
 if code~=200 then return nil end
 local ok,result=pcall(json.decode,reply)
 if ok then return result end
end
local function recent(text,limit)
 local length=utf8.len(text)
 if length and length>limit then return text:sub(utf8.offset(text,length-limit+1)) end
 return text
end
local function surrounding()
 local f=io.open('__CONTEXT_FILE__','r');if not f then return nil end
 local content=f:read('*a');f:close();local ok,result=pcall(json.decode,content)
 if not ok or not result.timestamp or math.abs(os.time()*1000-result.timestamp)>2000 then return nil end
 return result
end
function translator.init(env)
 env.history_chars=env.engine.schema.config:get_int('llm_context/history_chars') or 256
 env.learning=env.engine.schema.config:get_bool('llm_context/learning')~=false
 env.context_text='';env.after='';env.session='rime-'..tostring(os.time())..'-'..tostring(math.random(100000000))
 env.notifier=env.engine.context.commit_notifier:connect(function(ctx)
  local text=ctx:get_commit_text()
  if env.password then env.context_text='';env.input=nil;ctx:set_property('llm_job','');return end
  if text and text~='' then
   local previous=env.before or env.context_text
   local selectedkeys=nil
   for _,c in ipairs(env.candidates or {}) do if c.word==text then selectedkeys=(env.input or ''):sub(1,c.consumedkeys);break end end
   env.context_text=recent(previous..text,env.history_chars)
   env.before=env.context_text;env.input=nil;env.after=''
   local committed=request('commit',{text=text,context=previous,keys=selectedkeys,selected=selectedkeys~=nil and env.learning})
   env.last_commit_time=committed and committed.at or 0
   ctx:set_property('llm_job','')
  end
 end)
end
function translator.fini(env)if env.notifier then env.notifier:disconnect() end end
function translator.func(input,seg,env)
 local ctx=env.engine.context
 if not env.input or #input<=1 or (#input>#env.input and input:sub(1,#env.input)~=env.input) then
  local doc=surrounding()
  if doc and doc.docId~=env.docId then env.context_text='';env.docId=doc.docId end
  env.password=doc and doc.reason=='password' or false
  env.document=doc and doc.supported and not (doc.timestamp<=(env.last_commit_time or 0)) or false
  if env.document then env.before=recent(doc.before or '',env.history_chars);env.after=doc.after or ''
  else env.before=env.context_text;env.after='' end
 end
 env.input=input
 if env.password then ctx:set_property('llm_job','');return end
 local result=request('candidates',{keys=input,context=env.before or env.context_text,after=env.after,progressive=true,session=env.session,surrounding=env.document})
 if not result then return end
 -- A cold context has no initial logits. Wait only for the first useful result;
 -- cached contexts return immediately while additional paths run in background.
 if #result.candidates==0 and result.pending then result=request('result',{id=result.job,first=true}) or result end
 ctx:set_property('llm_job',result.job or '')
 env.candidates=result.candidates
 for _,v in ipairs(result.candidates) do
  local comment=v.correction and '纠错' or ''
  local c=Candidate('llm',seg.start,seg.start+v.consumedkeys,v.word,comment)
  c.preedit=v.preedit;yield(c)
 end
end
function processor.func(key,env)
 local ctx=env.engine.context
 if key:release() or not ctx:is_composing() then return 2 end
 -- Tab refreshes finished search; Space resolves the complete first choice.
 -- Numbered choices keep their displayed meaning.
 if key.keycode==0xff09 or key.keycode==32 then
  local id=ctx:get_property('llm_job')
  if id and id~='' then
   local selected=ctx:get_selected_candidate()
   if key.keycode==0xff09 or key.keycode==32 then
    request('result',{id=id,wait=true})
    ctx:refresh_non_confirmed_composition()
   end
  end
  if key.keycode==0xff09 then return 1 end
 end
 return 2
end
return {translator=translator,processor=processor}
