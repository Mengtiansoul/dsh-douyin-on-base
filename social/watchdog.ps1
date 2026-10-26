$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
$Cfg = Join-Path (Split-Path $PSScriptRoot -Parent) 'config.json'
$Log = Join-Path $Dir 'watchdog.log'

function Rotate([string]$f) {
  try {
    if ((Test-Path $f) -and ((Get-Item $f).Length -gt 5MB)) {
      if (Test-Path ($f + '.1')) { Remove-Item ($f + '.1') -Force -ErrorAction SilentlyContinue }
      Move-Item $f ($f + '.1') -Force
    }
  } catch {}
}
Rotate $Log
Rotate (Join-Path $Dir 'bridge.out.log')

function W([string]$m) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + "`r`n"
  [System.IO.File]::AppendAllText($Log, $line, (New-Object System.Text.UTF8Encoding($false)))
}

# 用 node 读配置，避免 PowerShell 的 JSON 类型坑
$socialOff = 'false'
try {
  $socialOff = & node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(!!(j.modules&&j.modules.social===false)))}catch(e){process.stdout.write('false')}" $Cfg
} catch { $socialOff = 'false' }

$found = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like '*bridge.mjs*' })

if ($socialOff -eq 'true') {
  foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($found.Count -gt 0) { W ('SOCIAL_OFF killed=' + $found.Count) }
  exit 0
}

if ($found.Count -gt 0) { exit 0 }

W 'DOWN -> restarting'
try {
  Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentList 'bridge.mjs' `
    -WorkingDirectory $Dir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Dir 'bridge.out.log') `
    -RedirectStandardError  (Join-Path $Dir 'bridge.err.log')
  Start-Sleep -Seconds 10
  $back = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*bridge.mjs*' })
  if ($back.Count -gt 0) { W ('RESTARTED pid=' + ($back.ProcessId -join ',')) }
  else { W 'RESTART_FAILED' }
} catch {
  W ('ERROR ' + $_.Exception.Message)
}