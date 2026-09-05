$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root '.tools'
New-Item -ItemType Directory -Force $tools | Out-Null

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "No C# compiler at $csc" }

$runner = Join-Path $root 'docker\epub-layout-fix'

$source = @"
using System;
using System.Diagnostics;

class Launcher {
    static int Main(string[] args) {
        var psi = new ProcessStartInfo("python");
        psi.Arguments = "\"$($runner -replace '\\', '\\')\"";
        foreach (var a in args) psi.Arguments += " \"" + a + "\"";
        psi.UseShellExecute = false;
        var p = Process.Start(psi);
        p.WaitForExit();
        return p.ExitCode;
    }
}
"@

$cs = Join-Path $tools 'launcher.cs'
$exe = Join-Path $tools 'epub-layout-fix.exe'
Set-Content $cs $source -Encoding utf8
& $csc /nologo /target:exe /out:$exe $cs | Out-Null
Remove-Item $cs -Force
Write-Host "built $exe"
