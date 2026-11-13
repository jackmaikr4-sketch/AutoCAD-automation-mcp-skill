param([string]$AutoCADDir='C:/Program Files/Autodesk/AutoCAD 2026')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$dotnet=Join-Path $root 'tools/dotnet/dotnet.exe'
if(!(Test-Path $dotnet)){$dotnet=(Get-Command dotnet).Source}
if(!(Test-Path (Join-Path $AutoCADDir 'acmgd.dll'))){throw 'AutoCAD 2026 .NET API not found'}
& $dotnet build (Join-Path $root 'bridge/AiCad.csproj') --nologo -v:q -clp:ErrorsOnly '-p:AssemblyName=AiCadBridge5' "-p:AutoCADDir=$AutoCADDir"
if($LASTEXITCODE){throw 'Build failed. If DLL is loaded, restart AutoCAD after saving your drawings.'}
[IO.File]::WriteAllText((Join-Path $root 'bin/current.json'),'{"dll":"AiCadBridge5.dll","command":"AICADREQUEST5"}')
