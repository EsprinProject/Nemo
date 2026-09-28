# Esprin Nemo - keep a window at the bottom of the z-order (desktop layer).
#
# Why this file exists:
#   A desktop sticky note must sit on the desktop itself, below every application window.
#   Win32 does that with SetWindowPos(hwnd, HWND_BOTTOM, ...), while Electron can only raise
#   a window (setAlwaysOnTop) - there is no "send to bottom" API and no desktop window type
#   outside Linux. The call therefore lives in this helper.
#
# Why this file is ASCII-only with English comments:
#   Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI, so non-ASCII source breaks
#   parsing. The host (src/main/desktop_layer.js) never runs this file from disk: it reads the
#   text, encodes it as UTF-16LE base64 and passes it through -EncodedCommand, which also
#   removes every command-line quoting question. Same convention as speech_windows.ps1.
#
# Protocol: one window handle per line on stdin (decimal, written by the host).
#   'quit' ends the process. stdout stays empty; failures go to stderr as one line each.
$ErrorActionPreference = 'Stop'

Add-Type -Namespace EsprinNemo -Name DesktopLayer -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@

# HWND_BOTTOM: the window goes below every other top-level window, still above the desktop.
$BOTTOM = [IntPtr]1
# SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER
$FLAGS = 0x0213

$reader = [Console]::In
while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }

    $value = $line.Trim()
    if ($value -eq '') { continue }
    if ($value -eq 'quit') { break }

    try {
        $hwnd = [IntPtr]([Int64]$value)
        if (-not [EsprinNemo.DesktopLayer]::SetWindowPos($hwnd, $BOTTOM, 0, 0, 0, 0, $FLAGS)) {
            $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            [Console]::Error.WriteLine("SetWindowPos failed (hwnd=$value code=$code)")
        }
    } catch {
        [Console]::Error.WriteLine("bad window handle: $value")
    }
}
