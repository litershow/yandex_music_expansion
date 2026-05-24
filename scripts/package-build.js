// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const buildPath = path.join(projectRoot, 'build');
const releasePath = path.join(projectRoot, 'release');

if (!fs.existsSync(buildPath)) {
  throw new Error('Build directory does not exist. Run the build first.');
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const archiveName = `${packageJson.name}-${packageJson.version}.zip`;
const archivePath = path.join(releasePath, archiveName);

fs.mkdirSync(releasePath, {recursive: true});

if (fs.existsSync(archivePath)) {
  fs.rmSync(archivePath, {force: true});
}

const powershellCommand =
  process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const escapedSingleQuote = String.fromCharCode(39, 39);
const escapePowerShellPath = targetPath =>
  targetPath.replace(/'/g, escapedSingleQuote);

execFileSync(
  powershellCommand,
  [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    `Compress-Archive -LiteralPath '${escapePowerShellPath(
      buildPath
    )}' -DestinationPath '${escapePowerShellPath(archivePath)}' -Force`,
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
  }
);

console.log(`Created archive: ${archivePath}`);
