$ErrorActionPreference = 'Stop'
$botWindows = @(Get-Process msrdc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Vintage Story (Ubuntu)' -and $_.MainWindowHandle -ne 0 })
if ($botWindows.Count -ne 1) { throw 'Expected one Vintage Story (Ubuntu) WSLg window.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BotWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    public static bool Focus(IntPtr h) {
        ShowWindow(h, 9);
        SetForegroundWindow(h);
        if (GetForegroundWindow() == h) return true;
        uint current = GetCurrentThreadId();
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
        try {
            BringWindowToTop(h);
            SetForegroundWindow(h);
            return GetForegroundWindow() == h;
        } finally {
            if (attached) AttachThreadInput(current, foreground, false);
        }
    }
}
'@
$handle = $botWindows[0].MainWindowHandle
if (-not [BotWindow]::Focus($handle)) { throw 'Windows refused bot foreground activation.' }
