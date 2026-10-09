local json=require("json")
local fetch_text=require("fetch_text")
local translator={}
local function request(route,body)
 local code,reply=fetch_text("http://127.0.0.1:5000/api/"..route,{source=json.encode(body),key="__LOCAL_KEY__"})
 if code~=200 then return nil end
 local ok,result=pcall(json.decode,reply)
 if ok then return result end
 return nil
end
local function recent(text,limit)
 local length=utf8.len(text)
 if length and length>limit then return text:sub(utf8.offset(text,length-limit+1)) end
 return text
end
function translator.init(env)
 env.history_chars=env.engine.schema.config:get_int("llm_context/history_chars") or 256
 env.context_text=""
 env.notifier=env.engine.context.commit_notifier:connect(function(ctx)
  local text=ctx:get_commit_text()
  if text and text~="" then
   local previous=env.context_text
   env.context_text=recent(previous..text,env.history_chars)
   request("commit",{text=text,new=true,context=previous})
  end
 end)
end
function translator.fini(env)
 if env.notifier then env.notifier:disconnect() end
end
function translator.func(input,seg,env)
 local result=request("candidates",{keys=input,context=env.context_text})
 if not result then return end
 for _,v in ipairs(result.candidates) do
  local c=Candidate("llm",seg.start,seg.start+v.consumedkeys,v.word,"")
  c.preedit=v.preedit
  yield(c)
 end
end
return {translator=translator}
