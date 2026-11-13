$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$cfgDir=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'}
$cfg=Join-Path $cfgDir 'config.toml'
if(Test-Path $cfg){Copy-Item -LiteralPath $cfg -Destination ($cfg+'.backup-autocad-'+(Get-Date -Format yyyyMMddHHmmss))}
& codex mcp add autocad-ai-mcp --env ('AICAD_PYTHON='+(Get-Command python.exe).Source) -- (Get-Command node.exe).Source (Join-Path $root 'src/server.mjs')
if($LASTEXITCODE){throw 'MCP registration failed'}
$text=[IO.File]::ReadAllText($cfg)
$text=[regex]::Replace($text,'(?ms)(^\[mcp_servers\.autocad-ai-mcp\]\r?\n)(.*?)(?=^\[|\z)',[Text.RegularExpressions.MatchEvaluator]{param($m)
 $body=[regex]::Replace($m.Groups[2].Value,'(?m)^(startup_timeout_sec|tool_timeout_sec)\s*=.*\r?\n?','').TrimEnd()
 $m.Groups[1].Value+$body+"`nstartup_timeout_sec = 30`ntool_timeout_sec = 600`n`n"
})
[IO.File]::WriteAllText($cfg,$text,[Text.UTF8Encoding]::new($false))
$skill=Join-Path $cfgDir 'skills/autocad-ai-modeling'
New-Item -ItemType Directory -Force $skill | Out-Null
$skillText=[IO.File]::ReadAllText((Join-Path $root 'skill/SKILL.md')).Replace('__PROJECT_ROOT__',$root.Replace('\','/'))
[IO.File]::WriteAllText((Join-Path $skill 'SKILL.md'),$skillText,[Text.UTF8Encoding]::new($false))
Write-Output 'Registered AutoCAD MCP and installed modeling skill. Reload MCP or start a new chat.'
