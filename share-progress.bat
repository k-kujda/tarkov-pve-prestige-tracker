@echo off
setlocal
rem Reads YOUR Escape from Tarkov quest progress from the game's own log files (read-only)
rem and copies a sync code to the clipboard. Paste it to your friend for their Tarkov tracker.
rem Nothing is uploaded anywhere; only quest ids and their status end up in the code.
echo Tarkov tracker - share quest progress
echo.
set "TPT_NAME="
set /p "TPT_NAME=Your name as your friend should see it [%USERNAME%]: "
if "%TPT_NAME%"=="" set "TPT_NAME=%USERNAME%"
set "TPT_MODE="
set /p "TPT_MODE=Game mode - pve or regular [pve]: "
if "%TPT_MODE%"=="" set "TPT_MODE=pve"
set "TPT_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText($env:TPT_SELF); iex $s.Substring($s.IndexOf('#PS' + 'START'))"
echo.
pause
exit /b
#PSSTART
$ErrorActionPreference = 'Stop'
try {
  # Locate the game's Logs folder: launcher / Steam uninstall entries, Steam libraries, default folders on every drive.
  # If several exist, use the one played most recently. Set TARKOV_LOGS to override.
  $logs = $env:TARKOV_LOGS
  if (-not $logs) {
    $installs = @()
    foreach ($hive in 'HKCU:', 'HKLM:') {
      foreach ($node in 'SOFTWARE\WOW6432Node', 'SOFTWARE') {
        foreach ($app in 'EscapeFromTarkov', 'Steam App 3932890') {
          $loc = (Get-ItemProperty -Path "$hive\$node\Microsoft\Windows\CurrentVersion\Uninstall\$app" -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
          if ($loc) { $installs += $loc }
        }
      }
    }
    $steamRoots = @()
    foreach ($k in @(@('HKCU:\SOFTWARE\Valve\Steam', 'SteamPath'), @('HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath'), @('HKLM:\SOFTWARE\Valve\Steam', 'InstallPath'))) {
      $p = (Get-ItemProperty -Path $k[0] -Name $k[1] -ErrorAction SilentlyContinue).($k[1])
      if ($p) { $steamRoots += $p }
    }
    foreach ($root in ($steamRoots | Select-Object -Unique)) {
      $libraries = @($root)
      $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
      if (Test-Path -LiteralPath $vdf) {
        foreach ($m in [regex]::Matches([IO.File]::ReadAllText($vdf), '"path"\s+"([^"]+)"')) { $libraries += $m.Groups[1].Value -replace '\\\\', '\' }
      }
      foreach ($lib in $libraries) {
        $acf = Join-Path $lib 'steamapps\appmanifest_3932890.acf'
        if (Test-Path -LiteralPath $acf) {
          $dir = [regex]::Match([IO.File]::ReadAllText($acf), '"installdir"\s+"([^"]+)"').Groups[1].Value
          if ($dir) { $installs += (Join-Path $lib "steamapps\common\$dir") }
        }
      }
    }
    foreach ($drive in (Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root })) {
      foreach ($d in 'Battlestate Games\EFT', 'Battlestate Games\Escape from Tarkov', 'Games\Battlestate Games\EFT') { $installs += (Join-Path $drive $d) }
    }
    $found = @()
    foreach ($i in ($installs | Select-Object -Unique)) {
      foreach ($c in (Join-Path $i 'Logs'), (Join-Path $i 'build\Logs')) {
        if (Test-Path -LiteralPath $c) {
          $newest = (Get-ChildItem -LiteralPath $c -Directory -Filter 'log_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
          $found += [pscustomobject]@{ path = $c; newest = $(if ($newest) { $newest } else { [datetime]::MinValue }) }
        }
      }
    }
    $logs = ($found | Sort-Object newest -Descending | Select-Object -First 1).path
  }
  if (-not $logs) { throw 'Could not find the Escape from Tarkov Logs folder. Set TARKOV_LOGS to its path and run this again.' }
  Write-Host "Reading logs from: $logs"

  # The game keeps its log files open, so read them with shared access.
  function Read-Shared($path) {
    $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    try { (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Dispose() }
  }
  function Folder-Time($name) {
    if ($name -match 'log_(\d+)\.(\d+)\.(\d+)_(\d+)-(\d+)-(\d+)') {
      return '{0:D4}{1:D2}{2:D2}{3:D2}{4:D2}{5:D2}' -f [int]$matches[1], [int]$matches[2], [int]$matches[3], [int]$matches[4], [int]$matches[5], [int]$matches[6]
    }
    return '0'
  }

  $wanted = @{ pve = 'Pve'; regular = 'Regular' }[$env:TPT_MODE.ToLower()]
  if (-not $wanted) { $wanted = 'Pve' }
  $status = @{ '10' = 'a'; '11' = 'f'; '12' = 'd' }
  $events = New-Object System.Collections.Generic.List[object]
  $folders = Get-ChildItem -LiteralPath $logs -Directory -Filter 'log_*' | Sort-Object { Folder-Time $_.Name }
  foreach ($f in $folders) {
    $files = Get-ChildItem -LiteralPath $f.FullName -File
    $app = ($files | Where-Object { $_.Name -match 'application(_\d+)?\.log$' } | ForEach-Object { Read-Shared $_.FullName }) -join "`n"
    $modes = @([regex]::Matches($app, '(?m)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\|[^\n]*?Session mode: (\w+)') | ForEach-Object { @{ at = $_.Groups[1].Value; mode = $_.Groups[2].Value } })
    foreach ($nf in ($files | Where-Object { $_.Name -match 'notifications(_\d+)?\.log$' })) {
      $txt = Read-Shared $nf.FullName
      foreach ($m in [regex]::Matches($txt, '(?m)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\|[^\n]*\n(\{[\s\S]+?^\})')) {
        $body = $m.Groups[2].Value
        $t = [regex]::Match($body, '"type":\s*(1[012]),')
        $q = [regex]::Match($body, '"templateId":\s*"([0-9a-f]{24}) ')
        if (-not $t.Success -or -not $q.Success) { continue }
        $at = $m.Groups[1].Value
        $mode = $null
        foreach ($x in $modes) { if ($x.at -le $at) { $mode = $x.mode } }
        if (-not $mode -and $modes.Count) { $mode = $modes[0].mode }
        if ($mode -ne $wanted) { continue }
        $events.Add([pscustomobject]@{ at = $at; id = $q.Groups[1].Value; st = $status[$t.Groups[1].Value] })
      }
    }
  }
  $events = @($events | Sort-Object at)

  # A prestige or wipe = 5+ already-finished quests started again within 30 minutes: keep only the current run.
  $since = $null
  $finished = New-Object System.Collections.Generic.HashSet[string]
  $window = @()
  foreach ($e in $events) {
    if ($e.st -eq 'd') { [void]$finished.Add($e.id) }
    if ($e.st -ne 'a' -or -not $finished.Contains($e.id)) { continue }
    $t = [datetime]::ParseExact($e.at, 'yyyy-MM-dd HH:mm:ss.fff', $null)
    $window = @($window | Where-Object { ($t - $_).TotalMinutes -lt 30 }) + $t
    if ($window.Count -ge 5) {
      $first = $window[0]
      $since = ($events | Where-Object { $_.st -eq 'a' -and $finished.Contains($_.id) -and [datetime]::ParseExact($_.at, 'yyyy-MM-dd HH:mm:ss.fff', $null) -ge $first } | Select-Object -First 1).at
      $finished.Clear(); $window = @()
    }
  }
  $quests = @{}
  foreach ($e in $events) { if (-not $since -or $e.at -ge $since) { $quests[$e.id] = $e.st } }

  $payload = [ordered]@{
    v = 1; n = $env:TPT_NAME; m = $env:TPT_MODE.ToLower(); s = $since
    x = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    d = @($quests.Keys | Where-Object { $quests[$_] -eq 'd' }); a = @($quests.Keys | Where-Object { $quests[$_] -eq 'a' }); f = @($quests.Keys | Where-Object { $quests[$_] -eq 'f' })
  }
  $json = $payload | ConvertTo-Json -Compress
  $ms = New-Object IO.MemoryStream
  $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $gz.Write($bytes, 0, $bytes.Length); $gz.Dispose()
  $code = 'TPTF1.' + [Convert]::ToBase64String($ms.ToArray())
  if ($env:TPT_OUT) { [IO.File]::WriteAllText($env:TPT_OUT, $code) } else { Set-Clipboard -Value $code }
  Write-Host ''
  Write-Host ("Found {0} done, {1} active, {2} failed quests ({3}, current run since {4})." -f $payload.d.Count, $payload.a.Count, $payload.f.Count, $wanted, $(if ($since) { $since } else { 'start of logs' }))
  Write-Host ("Sync code copied to your clipboard ({0} characters) - paste it to your friend." -f $code.Length) -ForegroundColor Green
  if ($code.Length -gt 2000) { Write-Host 'It is longer than a Discord message: Discord will turn it into a message.txt file, which works too.' }
} catch {
  Write-Host ('Failed: ' + $_.Exception.Message) -ForegroundColor Red
}
