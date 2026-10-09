local json=require("json")
local pipe=nil
return function(url,op)
 if not pipe then pipe=io.open("\\\\.\\pipe\\lime-npu","r+b") end
 if not pipe then return nil,nil end
 local route=url:match("/api/([^/]+)$")
 local ok,result=pcall(function()
  pipe:write(json.encode({route=route,key=op.key,body=json.decode(op.source)}).."\n")
  pipe:flush()
  local line=pipe:read("*l")
  if not line then error("Pipe closed") end
  return json.decode(line)
 end)
 if not ok then pipe:close();pipe=nil;return nil,nil end
 return result.code,result.body
end
