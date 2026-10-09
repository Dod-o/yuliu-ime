$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
Push-Location $taskRoot
try{
 & work/runtime/node_modules/deno/deno.exe check --config lime/deno.json lime/server.ts
 if($LASTEXITCODE){throw 'Type check failed'}
 & work/runtime/node_modules/deno/deno.exe test -A --config lime/deno.json tests/core_test.ts
 if($LASTEXITCODE){throw 'Unit tests failed'}
 foreach($taskTest in @('tests/integration_npu.py','work/test_rime_npu.py','work/test_rime_short_context.py','tests/rime_document_context.py','tests/rime_preedit.py','tests/rime_complete_candidates.py','tests/latency_npu.py','tests/first_candidate_npu.py')){
  & python $taskTest
  if($LASTEXITCODE){throw "Test failed: $taskTest"}
 }
}finally{Pop-Location}
