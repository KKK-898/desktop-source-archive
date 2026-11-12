[CmdletBinding()]
param(
    [string]$ExecutablePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ExecutablePath = Join-Path $scriptRoot '..\src-tauri\target\debug\gaoge-free.exe'
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw 'Standalone build missing. Run: npx tauri build --debug --no-bundle --ci'
}
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).ProviderPath
if ([System.IO.Path]::GetFileName($resolvedExecutable) -ine 'gaoge-free.exe') {
    throw 'The standalone launcher only accepts gaoge-free.exe.'
}

$existingClients = @(Get-CimInstance Win32_Process -Filter "Name = 'gaoge-free.exe'" |
    Where-Object { $_.CommandLine -notmatch '(?:^|\s)--gaoge-image-mcp(?:\s|$)' })
if ($existingClients.Count -gt 0) {
    $runningPaths = ($existingClients | ForEach-Object { $_.ExecutablePath }) -join ', '
    throw "Exit the running Gaoge client from its tray menu first: $runningPaths"
}

if (-not ('Gaoge.StandaloneProcessProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Gaoge {
    public static class StandaloneProcessProbe {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        public static bool InJob(uint processId) {
            IntPtr handle = OpenProcess(0x1000, false, processId);
            if (handle == IntPtr.Zero) throw new Win32Exception();
            try {
                bool result;
                if (!IsProcessInJob(handle, IntPtr.Zero, out result)) throw new Win32Exception();
                return result;
            } finally {
                CloseHandle(handle);
            }
        }
    }
}
'@
}

# Start-Process still inherits a caller's kill-on-close job. WMI creates the
# client from its service host, outside both the caller's job and process tree.
# BREAKAWAY_FROM_JOB avoids inheriting the provider's job; NO_WINDOW suppresses
# the debug executable's console while leaving the actual app window visible.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
    CreateFlags = [uint32]0x09000000
    ShowWindow = [uint16]1
    WinstationDesktop = 'winsta0\default'
}
$launch = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = ('"{0}"' -f $resolvedExecutable)
    CurrentDirectory = [System.IO.Path]::GetDirectoryName($resolvedExecutable)
    ProcessStartupInformation = $startup
}
if ($launch.ReturnValue -ne 0) {
    throw "Windows could not start the independent client (error $($launch.ReturnValue))."
}

$clientProcess = Get-Process -Id $launch.ProcessId -ErrorAction Stop
$callerSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
if ($clientProcess.SessionId -ne $callerSessionId) {
    throw 'The client did not start in the current desktop session.'
}
if ([Gaoge.StandaloneProcessProbe]::InJob($launch.ProcessId)) {
    throw 'The client is still in a Windows job; independent startup could not be verified.'
}

$deadline = [DateTime]::UtcNow.AddSeconds(25)
do {
    $clientProcess.Refresh()
    if ($clientProcess.HasExited) {
        throw 'The client exited before its window opened. Check the Gaoge application log.'
    }
    if ($clientProcess.MainWindowHandle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)
if ($clientProcess.MainWindowHandle -eq [IntPtr]::Zero) {
    throw "Client started (PID $($launch.ProcessId)), but its window is not ready yet."
}

[pscustomobject]@{
    ProcessId = $launch.ProcessId
    ExecutablePath = $resolvedExecutable
    Independent = $true
    WindowReady = $true
}
