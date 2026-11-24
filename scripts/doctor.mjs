import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const cadDirectory =
  process.argv[2] || process.env.AICAD_AUTOCAD_DIR || 'C:/Program Files/Autodesk/AutoCAD 2026';
const python = process.env.AICAD_PYTHON || 'python';
const probe = spawnSync(
  python,
  [
    '-c',
    'import json,pythoncom,win32com.client,PIL,winreg; key=winreg.OpenKey(winreg.HKEY_CLASSES_ROOT,"AutoCAD.Application.25.1"+chr(92)+"CLSID"); print(json.dumps({"comClass":winreg.QueryValueEx(key,None)[0]}))',
  ],
  { encoding: 'utf8', timeout: 15000, windowsHide: true },
);
const localSdk = path.join(root, 'tools/dotnet/dotnet.exe');
const dotnet = fs.existsSync(localSdk) ? localSdk : 'dotnet';
const sdk = spawnSync(dotnet, ['--list-sdks'], {
  encoding: 'utf8',
  timeout: 15000,
  windowsHide: true,
});
const ffmpeg = spawnSync(process.env.AICAD_FFMPEG || 'ffmpeg', ['-version'], {
  encoding: 'utf8',
  timeout: 15000,
  windowsHide: true,
});
const files = Object.fromEntries(
  ['acad.exe', 'acmgd.dll', 'acdbmgd.dll', 'accoremgd.dll', 'acdbmgdbrep.dll'].map((name) => [
    name,
    fs.existsSync(path.join(cadDirectory, name)),
  ]),
);
const report = {
  cadDirectory,
  files,
  pythonAndComReady: probe.status === 0,
  pythonError: probe.error?.message || (probe.status === 0 ? null : probe.stderr.trim()),
  dotnet8SdkReady: sdk.status === 0 && /^8\./m.test(sdk.stdout),
  recordingReady: ffmpeg.status === 0,
  bridgeBuilt: fs.existsSync(path.join(root, 'bin/current.json')),
  note: 'Read-only prerequisites check; does not prove licensing or a completed modeling task.',
};
report.readyToBuild =
  Object.values(files).every(Boolean) && report.pythonAndComReady && report.dotnet8SdkReady;
console.log(JSON.stringify(report, null, 2));
if (!report.readyToBuild) process.exitCode = 2;
