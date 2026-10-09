$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/stop.ps1"
$env:PYTHONIOENCODING='utf-8'
$npu=Start-Process -FilePath "$PSScriptRoot/work/python-arm64/python.exe" -ArgumentList '-u','work/npu_server.py' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput "$PSScriptRoot/work/npu-server.log" -RedirectStandardError "$PSScriptRoot/work/npu-server.err.log" -PassThru
$npu.Id | Set-Content "$PSScriptRoot/work/npu-server.pid"
$ready=$false
for($attempt=0;$attempt -lt 60;$attempt++) {
 if($npu.HasExited){throw 'NPU startup failed; see work/npu-server.err.log'}
 if((Get-Content "$PSScriptRoot/work/npu-server.log" -Raw -ErrorAction SilentlyContinue) -match 'bridge ready'){$ready=$true;break}
 Start-Sleep -Milliseconds 500
}
if(!$ready){throw 'NPU startup timed out'}
$server=Start-Process -FilePath "$PSScriptRoot/work/runtime/node_modules/deno/deno.exe" -ArgumentList 'serve','-A','--host','127.0.0.1','--port','5000','server.ts' -WorkingDirectory "$PSScriptRoot/lime" -WindowStyle Hidden -RedirectStandardOutput "$PSScriptRoot/work/server.log" -RedirectStandardError "$PSScriptRoot/work/server.err.log" -PassThru
$server.Id | Set-Content "$PSScriptRoot/work/server.pid"
$serviceReady=$false
$localKey=[IO.File]::ReadAllText("$PSScriptRoot/work/local-key.txt").Trim()
for($attempt=0;$attempt -lt 120;$attempt++) {
 if($server.HasExited){throw 'Input service failed; see work/server.err.log'}
 try {
  $null=Invoke-RestMethod -Uri 'http://127.0.0.1:5000/api/userdata' -Headers @{Authorization="Bearer $localKey"} -TimeoutSec 1
  $serviceReady=$true;break
 }catch { Start-Sleep -Milliseconds 500 }
}
if(!$serviceReady){throw 'Input service startup timed out'}
Write-Host 'NPU input service started: http://127.0.0.1:5000/try.html'
