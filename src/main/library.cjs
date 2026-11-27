const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const workshopAppId = '431960';
const maxDepth = 7;
const maxDirectories = 6000;
const maxMetadataBytes = 8 * 1024 * 1024;
const scanConcurrency = 12;
const videoFormats = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'mpg', 'mpeg', 'flv', 'ogv', 'ts', 'm2ts', '3gp', 'asf', 'vob']);
const imageFormats = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const supportedKinds = new Set(['video', 'scene', 'web', 'application']);
const ignoredDirectories = new Set(['.git', 'node_modules', '$recycle.bin', 'system volume information']);

function pathKey(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function extension(fileName) {
  return path.extname(fileName).slice(1).toLowerCase();
}

function inside(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativeFile(directory, file) {
  if (typeof file !== 'string' || !file.trim() || /[:\0]/.test(file)) return null;
  const localPath = file.replace(/[\\/]/g, path.sep);
  if (path.isAbsolute(localPath)) return null;
  const resolved = path.resolve(directory, localPath);
  return inside(directory, resolved) ? resolved : null;
}

async function checkedFile(directory, filePath) {
  if (!filePath) return null;
  try {
    const resolved = await fs.realpath(filePath);
    if (!inside(directory, resolved)) return null;
    const stats = await fs.stat(resolved);
    return stats.isFile() ? { path: resolved, size: stats.size, modifiedAt: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function resolveDirectory(directory) {
  try {
    const resolved = await fs.realpath(directory);
    return (await fs.stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function registryPath(key, name, flags = []) {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', name, ...flags], { windowsHide: true, timeout: 3000 });
    const match = stdout.match(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, 'im'));
    return match?.[1].trim().replace(/%([^%]+)%/g, (_, variable) => process.env[variable] || `%${variable}%`);
  } catch {
    return undefined;
  }
}

async function steamFile(directory, name) {
  try {
    return await fs.readFile(path.join(directory, 'steamapps', name), 'utf8');
  } catch {
    return '';
  }
}

function unescapeVdf(value) {
  return value.replace(/\\([\\"])/g, '$1');
}

async function steamLibraries(root) {
  const data = await steamFile(root, 'libraryfolders.vdf');
  const libraryEntries = data.matchAll(/^[\t ]*"(?:path|\d+)"[\t ]+"((?:\\.|[^"\\])*)"/gim);
  return [root, ...Array.from(libraryEntries, entry => unescapeVdf(entry[1])).filter(candidate => path.isAbsolute(candidate))];
}

async function steamSources(root) {
  const manifest = await steamFile(root, `appmanifest_${workshopAppId}.acf`);
  const installName = manifest.match(/"installdir"\s*"((?:\\.|[^"\\])+)"/i)?.[1];
  const decodedName = installName ? unescapeVdf(installName) : 'wallpaper_engine';
  const appDirectory = /[/\\:\0]/.test(decodedName) || decodedName === '.' || decodedName === '..' ? 'wallpaper_engine' : decodedName;
  const steamapps = path.join(root, 'steamapps');
  const projects = path.join(steamapps, 'common', appDirectory, 'projects');

  return [
    { path: path.join(steamapps, 'workshop', 'content', workshopAppId), label: 'Steam 创意工坊' },
    { path: path.join(projects, 'myprojects'), label: '本地项目' },
    { path: path.join(projects, 'defaultprojects'), label: '内置壁纸' },
  ];
}

async function discoverSources() {
  if (process.platform !== 'win32') return [];

  const registry = await Promise.all([
    registryPath('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    registryPath('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath', ['/reg:32']),
    registryPath('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath', ['/reg:64']),
  ]);
  const commonDirectories = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean).map(directory => path.join(directory, 'Steam'));
  // Standalone Steam libraries may remain on other drives after Steam is removed or relocated.
  const driveLibraries = registry.some(Boolean) ? [] : Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', drive => [`${drive}:\\Steam`, `${drive}:\\SteamLibrary`]).flat();
  const candidates = [...registry, ...commonDirectories, ...driveLibraries].filter(Boolean);
  const roots = new Map();
  for (const directory of await Promise.all(candidates.map(resolveDirectory))) {
    if (directory) roots.set(pathKey(directory), directory);
  }

  const libraries = (await Promise.all([...roots.values()].map(steamLibraries))).flat();
  const uniqueLibraries = new Map(libraries.map(directory => [pathKey(path.normalize(directory)), directory]));
  const possibleSources = (await Promise.all([...uniqueLibraries.values()].map(steamSources))).flat();
  const sources = new Map();
  for (const source of possibleSources) {
    const directory = await resolveDirectory(source.path);
    if (directory) sources.set(pathKey(directory), { ...source, path: directory });
  }
  return [...sources.values()];
}

async function projectMetadata(directory, fileName) {
  const manifest = await checkedFile(directory, path.join(directory, fileName));
  if (!manifest || manifest.size > maxMetadataBytes) return { metadata: {}, badMetadata: true };

  try {
    const json = (await fs.readFile(manifest.path, 'utf8')).replace(/^\uFEFF/, '');
    const metadata = JSON.parse(json);
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      return { metadata, manifest, badMetadata: false };
    }
  } catch {
    // Files with unreadable metadata are still represented in the library.
  }
  return { metadata: {}, manifest, badMetadata: true };
}

function kindFromExtension(ext) {
  if (videoFormats.has(ext)) return 'video';
  if (ext === 'pkg' || ext === 'json') return 'scene';
  if (ext === 'html' || ext === 'htm') return 'web';
  if (ext === 'exe') return 'application';
  return 'unknown';
}

function projectFromFiles({ directory, source, metadata = {}, file, declaredPath, preview, manifest, kind, workshopId, loose = false }) {
  const title = typeof metadata.title === 'string' && metadata.title.trim();
  const ext = extension(file?.path || declaredPath || '');
  const defaults = { video: '视频', scene: '场景', web: '网页', application: '应用', unknown: '未知' };
  const identity = pathKey(loose ? file.path : directory);
  return {
    id: createHash('sha256').update(identity).digest('hex').slice(0, 24),
    title: title || (loose ? path.basename(file.path, path.extname(file.path)) : path.basename(directory)),
    kind,
    format: ext ? ext.toUpperCase() : defaults[kind],
    directory,
    previewPath: preview?.path ?? null,
    videoPath: kind === 'video' && videoFormats.has(ext) ? file?.path ?? null : null,
    size: file?.size ?? 0,
    modifiedAt: file?.modifiedAt ?? manifest?.modifiedAt ?? preview?.modifiedAt ?? 0,
    source,
    workshopId,
  };
}

function wallpaperId(directory, metadata = {}) {
  const folderId = directory.match(/(?:^|[\\/])431960[\\/](\d+)$/)?.[1];
  const declaredId = String(metadata.workshopid ?? '');
  return folderId ?? (/^\d+$/.test(declaredId) ? declaredId : null);
}

function findMainFile(entries, kind) {
  const main = entries.filter(name => !/^project\.json$/i.test(name));
  if (kind === 'video') return main.find(name => videoFormats.has(extension(name)) && !/^(preview|thumbnail)\./i.test(name));
  if (kind === 'scene') return main.find(name => extension(name) === 'pkg') || main.find(name => /^scene\.json$/i.test(name));
  if (kind === 'web') return main.find(name => kindFromExtension(extension(name)) === 'web');
  if (kind === 'application') return main.find(name => extension(name) === 'exe');
  return main.find(name => kindFromExtension(extension(name)) !== 'unknown' && extension(name) !== 'json' && !/^(preview|thumbnail)\./i.test(name));
}

async function inspectProject(directory, source, fileNames, manifestName) {
  const { metadata, manifest, badMetadata } = await projectMetadata(directory, manifestName);
  const declaredPath = relativeFile(directory, metadata.file);
  const declaredPreview = relativeFile(directory, metadata.preview);
  const fallbackPreview = fileNames.find(name => /^(preview|thumbnail)\./i.test(name) && imageFormats.has(extension(name)));
  const declaredKind = String(metadata.type || '').toLowerCase().trim();
  let kind = supportedKinds.has(declaredKind) ? declaredKind : kindFromExtension(extension(declaredPath || ''));
  const [declaredFile, preview] = await Promise.all([
    checkedFile(directory, declaredPath),
    checkedFile(directory, declaredPreview && imageFormats.has(extension(declaredPreview)) ? declaredPreview : null)
      .then(found => found ?? checkedFile(directory, relativeFile(directory, fallbackPreview))),
  ]);

  // Published scenes may declare scene.json even though only scene.pkg is installed.
  // A missing declared video stays missing, even if the folder contains other clips.
  const hasDeclaredFile = typeof metadata.file === 'string' && metadata.file.trim();
  const fallbackFile = !hasDeclaredFile || kind === 'scene' ? findMainFile(fileNames, kind) : null;
  const file = declaredFile ?? await checkedFile(directory, relativeFile(directory, fallbackFile));
  if (kind === 'unknown' && file) kind = kindFromExtension(extension(file.path));

  return {
    project: projectFromFiles({ directory, source, metadata, file, declaredPath, preview, manifest, kind, workshopId: wallpaperId(directory, metadata) }),
    issue: badMetadata ? `无法读取项目配置：${directory}` : null,
  };
}

async function inspectLooseVideos(directory, source, fileNames, workshopId, maxFiles) {
  const videoNames = fileNames.filter(name => videoFormats.has(extension(name)) && !/^(preview|thumbnail)\./i.test(name));
  const previewName = fileNames.find(name => /^(preview|thumbnail)\./i.test(name) && imageFormats.has(extension(name)));
  const preview = await checkedFile(directory, relativeFile(directory, previewName));
  const projects = [];
  for (let index = 0; index < Math.min(videoNames.length, maxFiles); index += scanConcurrency) {
    const files = await Promise.all(videoNames.slice(index, Math.min(index + scanConcurrency, maxFiles))
      .map(fileName => checkedFile(directory, relativeFile(directory, fileName))));
    for (const file of files) {
      if (file) projects.push(projectFromFiles({ directory, source, file, preview, kind: 'video', workshopId, loose: true }));
    }
  }

  return projects;
}

async function knownChildren(directory, subdirectories) {
  const name = path.basename(directory).toLowerCase();
  const known = [];
  if (name === 'steamapps') {
    known.push(path.join('workshop', 'content', workshopAppId), path.join('common', 'wallpaper_engine', 'projects'));
  }
  if (name === 'workshop') known.push(path.join('content', workshopAppId));
  if (name === 'content') known.push(workshopAppId);
  if (subdirectories.has('steamapps')) known.push('steamapps');
  if (subdirectories.has('projects')) known.push('projects');
  if (name === 'projects') known.push('myprojects', 'defaultprojects');

  const available = (await Promise.all(known.map(entry => resolveDirectory(path.join(directory, entry)))))
    .filter(candidate => candidate && inside(directory, candidate));
  return available.length ? available : [...subdirectories.values()].map(child => path.join(directory, child));
}

async function inspectDirectory(directory, source, depth) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return { projects: [], children: [], issue: `无法读取目录：${directory}` };
  }

  const fileNames = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const manifestName = fileNames.find(name => name.toLowerCase() === 'project.json');
  if (manifestName) {
    const { project, issue } = await inspectProject(directory, source.label, fileNames, manifestName);
    return { projects: [project], children: [], issue };
  }

  const workshopId = wallpaperId(directory);
  const projects = depth <= 1 || workshopId
    ? await inspectLooseVideos(directory, source.label, fileNames, workshopId, 10000) : [];
  if (workshopId || depth >= maxDepth) return { projects, children: [] };

  const subdirectories = new Map(entries.filter(entry => entry.isDirectory() && !ignoredDirectories.has(entry.name.toLowerCase()))
    .map(entry => [entry.name.toLowerCase(), entry.name]));
  return { projects, children: await knownChildren(directory, subdirectories) };
}

async function scanLibrary(sources) {
  const projects = new Map();
  const issues = [];
  const reported = new Set();
  const report = issue => {
    if (!issue || reported.has(issue)) return;
    reported.add(issue);
    if (issues.length < 30) issues.push(issue);
  };

  for (const source of sources) {
    if (!source || typeof source.path !== 'string' || !path.isAbsolute(source.path)) continue;
    const directory = await resolveDirectory(source.path);
    if (!directory) {
      report(`找不到壁纸目录：${source.path}`);
      continue;
    }

    const queue = [{ directory, depth: 0 }];
    const queued = new Set([pathKey(directory)]);
    let limitReached = false;
    for (let offset = 0; offset < queue.length;) {
      const batch = queue.slice(offset, offset + scanConcurrency);
      offset += batch.length;
      const results = await Promise.all(batch.map(item => inspectDirectory(item.directory, source, item.depth)));
      for (const [index, { projects: found, children, issue }] of results.entries()) {
        report(issue);
        for (const project of found) {
          if (!projects.has(project.id)) projects.set(project.id, project);
        }
        for (const child of children) {
          const key = pathKey(child);
          if (queued.has(key)) continue;
          if (queue.length >= maxDirectories) {
            limitReached = true;
            break;
          }
          queued.add(key);
          queue.push({ directory: child, depth: batch[index].depth + 1 });
        }
      }
    }
    if (limitReached) report(`扫描达到目录数量上限：${directory}`);
  }

  if (reported.size > issues.length) issues.push(`另有 ${reported.size - issues.length} 项扫描提示`);
  return { projects: [...projects.values()], issues };
}

module.exports = { discoverSources, scanLibrary };
