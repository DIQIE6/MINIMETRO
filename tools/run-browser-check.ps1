param(
  [string]$Url = "http://127.0.0.1:8123/tools/browser-check.html",
  [string]$Shot = "shots/browser-check.png",
  [int]$Budget = 90000
)

$ErrorActionPreference = "Stop"
$root = "D:\DeepseekHarness\MiniMetro"
$reportPath = Join-Path $root "shots\browser-report.json"
Remove-Item $reportPath -ErrorAction SilentlyContinue

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$profile = Join-Path $env:TEMP ("mm-edge-" + [guid]::NewGuid().ToString("N").Substring(0, 8))

$before = (Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=$profile", "--window-size=1400,950",
  "--virtual-time-budget=$Budget", "--screenshot=$root\$Shot", $Url
)
$proc | Wait-Process -Timeout 150 -ErrorAction SilentlyContinue

for ($i = 0; $i -lt 60 -and -not (Test-Path $reportPath); $i++) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Milliseconds 800

if (-not (Test-Path $reportPath)) { Write-Output "NO REPORT FILE (browser did not finish)"; exit 2 }

$report = $null
for ($i = 0; $i -lt 20 -and $null -eq $report; $i++) {
  try { $report = Get-Content $reportPath -Raw | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 300 }
}
if ($null -eq $report) { Write-Output "REPORT FILE UNREADABLE"; exit 2 }
Write-Output "PASS=$($report.pass) FAIL=$($report.fail)"
foreach ($r in $report.results) {
  $flag = if ($r.ok) { "ok  " } else { "FAIL" }
  Write-Output "$flag $($r.name)  $($r.detail)"
}
if ($report.fail -gt 0) { exit 1 }
