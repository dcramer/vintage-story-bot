[CmdletBinding()]
param([string]$Distribution = 'Ubuntu')

$ErrorActionPreference = 'Stop'
$wslExe = Join-Path $env:WINDIR 'System32\wsl.exe'
$repository = Split-Path $PSScriptRoot -Parent
$linuxRepository = (& $wslExe -d $Distribution --exec wslpath -u $repository).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRepository.StartsWith('/')) {
    throw 'Could not resolve the repository path inside WSL.'
}

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Vintage Story AI.lnk'
$windowsGame = Join-Path $env:APPDATA 'Vintagestory\Vintagestory.exe'
$windowsArguments = '--dataPath="{0}"' -f (Join-Path $env:APPDATA 'VintagestoryAI')
$arguments = '-d "{0}" --exec bash "{1}/scripts/launch-bot-wsl.sh"' -f $Distribution, $linuxRepository
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if (Test-Path -LiteralPath $shortcutPath) {
    $isPreviousBot = $shortcut.TargetPath -eq $windowsGame -and $shortcut.Arguments -eq $windowsArguments
    $isWslBot = $shortcut.TargetPath -eq $wslExe -and $shortcut.Arguments -eq $arguments
    if (-not $isPreviousBot -and -not $isWslBot) {
        throw "An unrelated shortcut exists at $shortcutPath. Rename it before running setup."
    }
}
$shortcut.TargetPath = $wslExe
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $env:USERPROFILE
$shortcut.IconLocation = "$windowsGame,0"
$shortcut.Description = 'Vintage Story AI companion - Linux client in WSL'
$shortcut.Save()
Write-Output "Updated desktop shortcut: $shortcutPath"
Write-Output "Target: $wslExe $arguments"
$windowsClients = @(Get-Process -Name Vintagestory -ErrorAction SilentlyContinue)
Write-Output "Windows game processes currently running: $($windowsClients.Count)"
