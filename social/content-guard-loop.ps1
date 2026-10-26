$ErrorActionPreference = 'Continue'
$Dir     = $PSScriptRoot
$OnBase  = (Split-Path $PSScriptRoot -Parent)
$Profile = $env:BROWSER_PROFILE
if (-not $Profile) { try { $Profile = (Get-Content -LiteralPath (Join-Path $OnBase 'config.json') -Raw | ConvertFrom-Json).browserProfile } catch {} }
# 命令行里的路径用反斜杠，配置里可能是正斜杠 —— 统一再比
if ($Profile) { $Profile = (($Profile -replace '/', '\').TrimEnd('\')) }
$Log     = Join-Path $Dir 'content-guard.log'

function W([string]$m) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + "`r`n"
  [System.IO.File]::AppendAllText($Log, $line, (New-Object System.Text.UTF8Encoding($false)))
}

# 日志轮转：超过 5MB 就切成 .1
function Rotate([string]$f) {
  try {
    if ((Test-Path $f) -and ((Get-Item $f).Length -gt 5MB)) {
      if (Test-Path ($f + '.1')) { Remove-Item ($f + '.1') -Force -ErrorAction SilentlyContinue }
      Move-Item $f ($f + '.1') -Force
    }
  } catch {}
}

function Close-ButlerEdge([string]$reason) {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like "*$Profile*" })
  if ($procs.Count -eq 0) { return }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  W ("CLOSED reason=" + $reason + " killed=" + $procs.Count)
}

function MinutesOf([string]$hhmm) {
  if ($hhmm -match '^(\d{1,2}):(\d{2})$') { return ([int]$Matches[1]) * 60 + [int]$Matches[2] }
  return $null
}

function InAnyWindow($windows) {
  if (-not $windows -or $windows.Count -eq 0) { return $true }
  $now = (Get-Date)
  $cur = $now.Hour * 60 + $now.Minute
  foreach ($w in $windows) {
    $s = MinutesOf $w.start
    $e = MinutesOf $w.end
    if ($null -eq $s -or $null -eq $e) { continue }
    if ($s -le $e) { if ($cur -ge $s -and $cur -lt $e) { return $true } }
    else { if ($cur -ge $s -or $cur -lt $e) { return $true } }
  }
  return $false
}

Rotate $Log
W 'GUARD_LOOP started'

while ($true) {
  try {
    $interrupt = Join-Path $Dir 'interrupt.flag'
    if (Test-Path -LiteralPath $interrupt) {
      Remove-Item -LiteralPath $interrupt -Force -ErrorAction SilentlyContinue
      W 'INTERRUPT detected'
      Close-ButlerEdge 'interrupt'
    }

    $stop = Join-Path $Dir 'stop.flag'
    if (Test-Path -LiteralPath $stop) {
      Remove-Item -LiteralPath $stop -Force -ErrorAction SilentlyContinue
      W 'STOP requested'
      Close-ButlerEdge 'done'
    }

    $cfgPath = Join-Path $OnBase 'config.json'
    $stPath  = Join-Path $OnBase 'state.json'
    if ((Test-Path -LiteralPath $cfgPath) -and (Test-Path -LiteralPath $stPath)) {
      $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
      $st  = Get-Content -LiteralPath $stPath  -Raw | ConvertFrom-Json

      # ① 每日上限
      $capSec = [int]$cfg.limits.browseMinutes * 60
      $today  = (Get-Date).ToString('yyyy-MM-dd')
      $capFlag = Join-Path $Dir ('cap-closed-' + $today + '.flag')
      if ($st.date -eq $today -and [int]$st.browseSeconds -ge $capSec -and -not (Test-Path -LiteralPath $capFlag)) {
        Close-ButlerEdge ('cap ' + $st.browseSeconds + 's/' + $capSec + 's')
        Set-Content -LiteralPath $capFlag -Value (Get-Date).ToString('s') -Encoding utf8
        try { Start-Process -FilePath 'node' -ArgumentList 'daily-report.mjs' -WorkingDirectory $Dir -WindowStyle Hidden; W 'DAILY_REPORT fired (cap)' } catch {}
      }

      # ② 时段边界：配了时段但现在已经不在里面 → 关浏览器
      $wins = @()
      if ($cfg.schedule -and $cfg.schedule.windows) { $wins = @($cfg.schedule.windows) }
      if ($wins.Count -gt 0 -and -not (InAnyWindow $wins)) {
        $winFlag = Join-Path $Dir ('window-closed-' + $today + '.flag')
        if (-not (Test-Path -LiteralPath $winFlag)) {
          Close-ButlerEdge 'window'
          Set-Content -LiteralPath $winFlag -Value (Get-Date).ToString('s') -Encoding utf8
        }
      } else {
        $winFlag = Join-Path $Dir ('window-closed-' + $today + '.flag')
        if (Test-Path -LiteralPath $winFlag) { Remove-Item -LiteralPath $winFlag -Force -ErrorAction SilentlyContinue }
      }
    }
  } catch {
    W ('ERROR ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 5
}