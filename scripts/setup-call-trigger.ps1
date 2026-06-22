<#
.SYNOPSIS
  Launch Meeting Notes for meetings with NO login-resident app.

  Zoom:  a Scheduled Task fires when Zoom.exe starts and launches the app
         (Zoom opens per-call, so "Zoom started" == "you're about to meet").
  Teams: a Scheduled Task fires when Teams starts and launches a TINY watcher
         (a PowerShell loop). The watcher lives only while Teams is open, polls
         the mic, and launches the full app only when a call actually starts.
         When Teams closes, the watcher exits.

  Pair with the in-app settings: Run in the background, Watch for Zoom/Teams
  calls, and Quit when neither Zoom nor Teams is running. Then the app exists
  only during meetings.

.NOTES
  - Run in an ELEVATED (Administrator) PowerShell.
  - Windows only. Does NOT cover Google Meet / browser calls (no process).
  - "New" Teams installs to a versioned path that changes on update — re-run
    this script after a major Teams update so the trigger points at the new path.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-call-trigger.ps1
.EXAMPLE
  .\setup-call-trigger.ps1 -ExePath "C:\Apps\Meeting Notes.exe"
.EXAMPLE
  .\setup-call-trigger.ps1 -Uninstall
#>
param(
  [string]$ExePath = (Join-Path $env:USERPROFILE 'Desktop\Meeting Notes.exe'),
  [switch]$NoTeams,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ZoomTask = 'MeetingNotesZoom'
$TeamsTask = 'MeetingNotesTeams'
$WatcherDir = Join-Path $env:LOCALAPPDATA 'MeetingNotes'
$WatcherPath = Join-Path $WatcherDir 'teams-call-watcher.ps1'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { Write-Error 'Please run this in an Administrator PowerShell.'; return }

if ($Uninstall) {
  schtasks /Delete /TN $ZoomTask /F 2>$null | Out-Null
  schtasks /Delete /TN $TeamsTask /F 2>$null | Out-Null
  Remove-Item $WatcherPath -ErrorAction SilentlyContinue
  Write-Host 'Removed the Zoom/Teams launch tasks and watcher.'
  Write-Host 'To also disable process auditing: auditpol /set /subcategory:"Process Creation" /success:disable'
  return
}

if (-not (Test-Path $ExePath)) { Write-Error "App not found at: $ExePath  (pass -ExePath)"; return }

Write-Host 'Enabling Process Creation auditing (needed for the launch trigger)...'
auditpol /set /subcategory:"Process Creation" /success:enable | Out-Null

# Helper: register a Scheduled Task that runs $command $arguments when one of $procPaths starts.
function Register-LaunchTask($name, $procPaths, $command, $arguments) {
  $dataOr = ($procPaths | ForEach-Object { "Data='$_'" }) -join ' or '
  $query = "<QueryList><Query Id='0' Path='Security'><Select Path='Security'>*[System[EventID=4688]] and *[EventData[Data[@Name='NewProcessName'] and ($dataOr)]]</Select></Query></QueryList>"
  $escaped = [System.Security.SecurityElement]::Escape($query)
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Launch Meeting Notes for meetings.</Description></RegistrationInfo>
  <Triggers><EventTrigger><Enabled>true</Enabled><Subscription>$escaped</Subscription></EventTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>$command</Command><Arguments>$arguments</Arguments></Exec></Actions>
</Task>
"@
  $f = Join-Path $env:TEMP "$name.xml"
  Set-Content -Path $f -Value $xml -Encoding Unicode
  schtasks /Create /TN $name /XML "$f" /F | Out-Null
  Remove-Item $f -ErrorAction SilentlyContinue
}

# --- Zoom: launch the app directly ---
$zoomPath = "$env:APPDATA\Zoom\bin\Zoom.exe"
Register-LaunchTask $ZoomTask @($zoomPath) $ExePath '--hidden'
Write-Host "Zoom trigger registered ($zoomPath)."

# --- Teams: launch the lightweight watcher (only while Teams runs) ---
if (-not $NoTeams) {
  $teamsPaths = @()
  $classic = "$env:LOCALAPPDATA\Microsoft\Teams\current\Teams.exe"
  if (Test-Path $classic) { $teamsPaths += $classic }
  $pkg = Get-AppxPackage -Name 'MSTeams' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) {
    $newTeams = Join-Path $pkg.InstallLocation 'ms-teams.exe'
    if (Test-Path $newTeams) { $teamsPaths += $newTeams }
  }
  if ($teamsPaths.Count -eq 0) {
    Write-Host 'Teams not found — skipping the Teams trigger. (Re-run after installing/updating Teams.)'
  } else {
    New-Item -ItemType Directory -Force -Path $WatcherDir | Out-Null
    $watcher = @'
param([string]$ExePath)
$base = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
function Teams-Running { [bool](Get-Process -Name 'Teams','ms-teams' -ErrorAction SilentlyContinue) }
function Teams-MicInUse {
  $hits = @()
  foreach ($k in (Get-ChildItem "$base\NonPackaged" -ErrorAction SilentlyContinue)) {
    if ((Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).LastUsedTimeStop -eq 0) { $hits += $k.PSChildName }
  }
  foreach ($k in (Get-ChildItem $base -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -ne 'NonPackaged' })) {
    if ((Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).LastUsedTimeStop -eq 0) { $hits += $k.PSChildName }
  }
  [bool]($hits | Where-Object { $_ -match 'teams' })
}
# Live only while Teams is open. Launch the app when a Teams call starts and the
# app isn't already running. Exit when Teams closes.
while (Teams-Running) {
  if ((Teams-MicInUse) -and -not (Get-Process -Name 'Meeting Notes' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $ExePath -ArgumentList '--hidden'
  }
  Start-Sleep -Seconds 6
}
'@
    Set-Content -Path $WatcherPath -Value $watcher -Encoding UTF8
    $watcherArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatcherPath`" -ExePath `"$ExePath`""
    Register-LaunchTask $TeamsTask $teamsPaths 'powershell.exe' $watcherArgs
    Write-Host 'Teams trigger registered:'
    $teamsPaths | ForEach-Object { Write-Host "  - $_" }
  }
}

Write-Host ''
Write-Host 'Now open Meeting Notes once and enable (Settings): Run in the background,'
Write-Host 'Watch for Zoom/Teams calls, and Quit when neither Zoom nor Teams is running.'
Write-Host 'Test: launch Zoom (app appears in tray); start a Teams call (app appears on the call).'
Write-Host 'Remove everything: re-run with -Uninstall.  Re-run after a Teams update.'
