[CmdletBinding()]
param(
    [string]$GameDirectory = (Join-Path $env:APPDATA 'Vintagestory'),
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$gameExe = Join-Path $GameDirectory 'Vintagestory.exe'
$repository = Split-Path $PSScriptRoot -Parent
$buildDirectory = Join-Path $repository 'mod\bin\Release\net10.0'
$botDirectory = Join-Path $env:APPDATA 'VintagestoryAI'
$modDirectory = Join-Path $botDirectory 'Mods\VintageStoryAI'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Vintage Story AI.lnk'
$gameArguments = '--dataPath="{0}"' -f $botDirectory

foreach ($required in @($gameExe, (Join-Path $buildDirectory 'VintageStoryAI.dll'), (Join-Path $buildDirectory 'modinfo.json'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required file missing: $required. Build the mod before running setup."
    }
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and
    ($shortcut.TargetPath -ne $gameExe -or $shortcut.Arguments -ne $gameArguments)) {
    throw "A different shortcut already exists at $shortcutPath. Rename it before running setup."
}

New-Item -ItemType Directory -Path $modDirectory -Force | Out-Null
foreach ($fileName in @('VintageStoryAI.dll', 'modinfo.json')) {
    Copy-Item -LiteralPath (Join-Path $buildDirectory $fileName) -Destination (Join-Path $modDirectory $fileName) -Force
}
$shortcut.TargetPath = $gameExe
$shortcut.Arguments = $gameArguments
$shortcut.WorkingDirectory = $GameDirectory
$shortcut.IconLocation = "$gameExe,0"
$shortcut.Description = 'Vintage Story AI companion - separate game profile'
$shortcut.Save()

Write-Output "Bot profile: $botDirectory"
Write-Output "Bridge installed: $modDirectory"
Write-Output "Desktop shortcut: $shortcutPath"

if ($Launch) {
    $process = Start-Process -FilePath $gameExe -ArgumentList $gameArguments -WorkingDirectory $GameDirectory -PassThru
    Write-Output "Started bot client (PID $($process.Id)). Sign in with the bot account."
}
