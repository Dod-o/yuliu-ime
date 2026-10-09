$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ((& node -p 'process.arch') -ne 'arm64') { throw 'Native ARM64 Node.js is required.' }
New-Item -ItemType Directory -Force work/runtime,work/python-arm64,models | Out-Null
if (!(Test-Path 'work/runtime/node_modules/deno/deno.exe')) {
    & npm install --prefix work/runtime deno@2.9.6
    if ($LASTEXITCODE) { throw 'Deno installation failed' }
}
if (!(Test-Path 'work/python-arm64/python.exe')) {
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-arm64.zip' -OutFile work/python-arm64.zip
    Expand-Archive -LiteralPath work/python-arm64.zip -DestinationPath work/python-arm64 -Force
}
$modulePath = '../npu-env/Lib/site-packages'
$pthPath = Join-Path $PSScriptRoot 'work/python-arm64/python313._pth'
if (!(Get-Content $pthPath | Where-Object { $_ -eq $modulePath })) { Add-Content $pthPath $modulePath }
if (!(Test-Path 'work/npu-env/Lib/site-packages/geniex/__init__.py')) {
    & python -m pip install --target work/npu-env/Lib/site-packages geniex==0.7.1
    if ($LASTEXITCODE) { throw 'GenieX installation failed' }
}
$manifest = Get-Content model-manifest.json -Raw | ConvertFrom-Json
$modelPath = Join-Path 'models' $manifest.filename
if (!(Test-Path $modelPath)) {
    & curl.exe -L --fail --retry 2 -o $modelPath $manifest.url
    if ($LASTEXITCODE) { throw 'Model download failed' }
}
if ((Get-FileHash $modelPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'Model SHA-256 mismatch' }
Push-Location lime
try {
    & ../work/runtime/node_modules/deno/deno.exe install --frozen
    if ($LASTEXITCODE) { throw 'LIME dependency installation failed' }
} finally { Pop-Location }
& work/python-arm64/python.exe work/setup_key.py
& work/python-arm64/python.exe work/build_demo.py
& work/python-arm64/python.exe work/setup_rime_files.py
Write-Host 'Setup complete. Run ./start.ps1, then open http://127.0.0.1:5000/try.html'

if(Get-Command dotnet -ErrorAction SilentlyContinue){
 & dotnet build native/context-helper/ContextHelper.csproj -c Release --nologo
 if($LASTEXITCODE){throw 'Context helper build failed'}
}else{Write-Warning '.NET 10 SDK is needed to build document context helper.'}
