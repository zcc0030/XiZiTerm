import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')
);
const version = pkg.version;

const cargoBinDir = path.join(os.homedir(), '.cargo', 'bin');
const env = {
  ...process.env,
  PATH: `${cargoBinDir}${path.delimiter}${process.env.PATH || ''}`,
};

console.log(
  '[XiZiTerm] 1/2 Building standalone Tauri v2 release binary (with embedded frontend assets)...'
);
execSync('npx tauri build --no-bundle', {
  cwd: desktopDir,
  env,
  stdio: 'inherit',
});

const srcExe = path.join(
  desktopDir,
  'src-tauri',
  'target',
  'release',
  'xiziterm.exe'
);
if (!fs.existsSync(srcExe)) {
  throw new Error(`Expected release binary not found at ${srcExe}`);
}

const releaseDir = path.join(desktopDir, 'release');
const stagingDir = path.join(releaseDir, 'win-portable');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const dstExe = path.join(stagingDir, 'XiZiTerm.exe');
fs.copyFileSync(srcExe, dstExe);

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const zipName = `XiZiTerm-${version}-win-${arch}.zip`;
const zipPath = path.join(releaseDir, zipName);
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

console.log(`[XiZiTerm] 2/2 Creating portable archive ${zipName}...`);
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${dstExe.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`,
  ],
  { stdio: 'inherit' }
);

const exeMb = (fs.statSync(dstExe).size / (1024 * 1024)).toFixed(2);
const zipMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
console.log(
  `[XiZiTerm] Done! Standalone XiZiTerm.exe: ${exeMb} MB | Portable ZIP: ${zipMb} MB -> ${zipPath}`
);
