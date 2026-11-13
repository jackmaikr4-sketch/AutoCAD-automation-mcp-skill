param([string]$AutoCADDir='C:/Program Files/Autodesk/AutoCAD 2026')
$ErrorActionPreference='Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
 & npm.cmd ci
 if($LASTEXITCODE){throw 'Node dependencies failed'}
 & python -m pip install -r requirements.txt
 if($LASTEXITCODE){throw 'Python dependencies failed'}
 & "$PSScriptRoot/build.ps1" -AutoCADDir $AutoCADDir
 & "$PSScriptRoot/register-codex.ps1"
} finally {Pop-Location}
