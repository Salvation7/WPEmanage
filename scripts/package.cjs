const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'dist');
const manifest = require('../package.json');

function publish(staging, names) {
  const backup = path.join(staging, 'previous');
  fs.mkdirSync(backup);
  const saved = [];
  const published = [];

  try {
    for (const name of names) {
      const existing = path.join(output, name);
      if (fs.existsSync(existing)) {
        const stat = fs.lstatSync(existing);
        if (stat.isSymbolicLink()) throw new Error(`Unexpected link at ${existing}`);
        fs.renameSync(existing, path.join(backup, name));
        saved.push(name);
      }
    }
    for (const name of names) {
      fs.renameSync(path.join(staging, name), path.join(output, name));
      published.push(name);
    }
  } catch (error) {
    for (const name of published) {
      fs.renameSync(path.join(output, name), path.join(staging, name));
    }
    for (const name of saved) {
      fs.renameSync(path.join(backup, name), path.join(output, name));
    }
    throw error;
  }
}

function build() {
  if (process.platform !== 'win32') {
    throw new Error('Run the portable build on Windows.');
  }
  fs.accessSync(path.join(workspace, manifest.main), fs.constants.R_OK);
  const electron = require('electron');
  const runtime = path.dirname(electron);
  const versionSuffix = process.argv.includes('--versioned') ? `-${manifest.version}` : '';
  const folderName = `WallpaperShelf-win32-${process.arch}${versionSuffix}`;
  const archiveName = `${folderName}.zip`;

  fs.mkdirSync(output, { recursive: true });
  const realWorkspace = fs.realpathSync(workspace);
  const realOutput = fs.realpathSync(output);
  if (realOutput !== path.join(realWorkspace, 'dist')) {
    throw new Error('The dist directory must be inside the project.');
  }

  const staging = fs.mkdtempSync(path.join(realOutput, '.build-'));
  let built = false;
  try {
    const folder = path.join(staging, folderName);
    fs.cpSync(runtime, folder, { recursive: true });
    fs.renameSync(path.join(folder, path.basename(electron)), path.join(folder, 'WallpaperShelf.exe'));

    const resources = path.join(folder, 'resources');
    fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
    const app = path.join(resources, 'app');
    fs.mkdirSync(app);
    fs.cpSync(path.join(workspace, 'src'), path.join(app, 'src'), { recursive: true });
    const { name, productName, version, description, main } = manifest;
    const appManifest = { name, productName, version, description, main };
    fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(appManifest, null, 2)}\n`);

    execFileSync('tar.exe', ['-a', '-cf', archiveName, folderName], { cwd: staging, stdio: 'inherit' });
    publish(staging, [folderName, archiveName]);
    built = true;
  } finally {
    const backup = path.join(staging, 'previous');
    const hasBackup = fs.existsSync(backup) && fs.readdirSync(backup).length > 0;
    if (fs.realpathSync(staging) === staging && (built || !hasBackup)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  console.log(`Launcher: ${path.join(output, folderName, 'WallpaperShelf.exe')}`);
  console.log(`Archive:  ${path.join(output, archiveName)}`);
}

try {
  build();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
