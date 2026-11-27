const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const progressIntervalMs = 120;
const copyChunkSize = 1024 * 1024;

function sameFile(first, second) {
  return first.ino !== 0n && first.ino === second.ino && first.dev === second.dev;
}

function unchangedFile(first, second) {
  const sameIdentity = sameFile(first, second) || (first.ino === 0n && second.ino === 0n && first.dev === second.dev);
  return second.isFile() && sameIdentity && first.size === second.size && first.mtimeNs === second.mtimeNs;
}

function pathKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function isInside(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function fileNameForAttempt(name, attempt) {
  if (attempt === 1) return name;

  const { name: stem, ext } = path.parse(name);
  const suffix = ` (${attempt})`;
  const maxStemLength = Math.max(1, 255 - suffix.length - ext.length);
  const shortened = stem.slice(0, maxStemLength).replace(/[\uD800-\uDBFF]$/u, '');
  return `${shortened}${suffix}${ext}`;
}

async function placeFile(directory, name, sourceStat, place) {
  for (let attempt = 1; attempt <= 10000; attempt += 1) {
    const target = path.join(directory, fileNameForAttempt(name, attempt));
    try {
      await place(target);
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.stat(target, { bigint: true }).catch(() => null);
      if (existing && sameFile(sourceStat, existing)) return null;
    }
  }
  throw new Error('同名文件过多，无法分配文件名。');
}

async function copyVerified(source, sourceStat, target, reportBytes) {
  const input = await fs.open(source, 'r');
  let output;
  let verified = false;
  try {
    if (!unchangedFile(sourceStat, await input.stat({ bigint: true }))) {
      throw new Error('源视频发生变化，请重试。');
    }

    output = await fs.open(target, 'wx', Number(sourceStat.mode & 0o777n));
    const size = Number(sourceStat.size);
    const buffer = Buffer.allocUnsafe(Math.min(copyChunkSize, size));
    let bytes = 0;
    while (bytes < size) {
      const length = Math.min(buffer.length, size - bytes);
      const { bytesRead } = await input.read(buffer, 0, length, bytes);
      if (!bytesRead) break;
      await output.writeFile(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      reportBytes(bytes);
    }

    await output.utimes(Number(sourceStat.atimeNs) / 1e9, Number(sourceStat.mtimeNs) / 1e9);
    await output.sync();
    const currentSource = await fs.lstat(source, { bigint: true });
    const copied = await output.stat({ bigint: true });
    const published = await fs.lstat(target, { bigint: true });
    if (!unchangedFile(sourceStat, currentSource) || !unchangedFile(copied, published) || copied.size !== sourceStat.size) {
      throw new Error('复制期间源视频发生变化，请重试。');
    }
    verified = true;
  } finally {
    await input.close().catch(() => {});
    if (output) {
      const incomplete = verified ? null : await output.stat({ bigint: true }).catch(() => null);
      await output.close().catch(() => {});
      if (incomplete) {
        const current = await fs.lstat(target, { bigint: true }).catch(() => null);
        if (current && unchangedFile(incomplete, current)) await fs.unlink(target).catch(() => {});
      }
    }
  }
}

async function publishCopy(source, sourceStat, directory, name, reportBytes) {
  const temporaryFile = path.join(directory, `.wpe-${randomUUID()}.tmp`);
  await copyVerified(source, sourceStat, temporaryFile, reportBytes);
  try {
    return await placeFile(directory, name, sourceStat, (target) => fs.link(temporaryFile, target));
  } catch (error) {
    if (!error.code) throw error;
  } finally {
    await fs.unlink(temporaryFile).catch(() => {});
  }

  return placeFile(directory, name, sourceStat, (target) => copyVerified(source, sourceStat, target, reportBytes));
}

function errorMessage(error) {
  switch (error.code) {
    case 'ENOENT': return '视频或目标文件夹已不存在。';
    case 'EACCES':
    case 'EPERM': return '没有所需的访问权限，或文件正在被其他程序占用。';
    case 'EBUSY':
    case 'ETXTBSY': return '文件正在被其他程序占用。';
    case 'ENOSPC':
    case 'EDQUOT': return '目标磁盘空间不足。';
    case 'EFBIG': return '目标文件系统无法存放这么大的文件。';
    case 'EROFS': return '目标磁盘或文件夹为只读。';
    case 'ENOTDIR': return '目标路径不是文件夹。';
    case 'ENAMETOOLONG': return '文件名或目标路径过长。';
    default: return error.code ? `文件操作失败（${error.code}）。` : error.message;
  }
}

async function transferVideo(project, directory, mode, expectedSize, reportBytes) {
  const { videoPath, id, title } = project;
  const result = { id, title };
  if (!videoPath) return { ...result, status: 'skipped', message: '此项目没有可转移的视频文件。' };

  let target;
  try {
    const projectDirectory = await fs.realpath(project.directory);
    const entry = await fs.lstat(videoPath, { bigint: true });
    if (!entry.isFile()) return { ...result, status: 'skipped', message: '源视频不是普通文件。' };

    const source = await fs.realpath(videoPath);
    if (!isInside(projectDirectory, source)) {
      return { ...result, status: 'skipped', message: '源视频位于项目目录之外。' };
    }
    if (pathKey(path.dirname(source)) === pathKey(directory)) {
      return { ...result, status: 'skipped', message: '视频已在目标文件夹中。' };
    }

    const sourceStat = await fs.lstat(source, { bigint: true });
    if (!unchangedFile(entry, sourceStat) || Number(sourceStat.size) !== expectedSize) {
      throw new Error('源视频发生变化，请重试。');
    }

    const name = path.basename(source);
    if (mode === 'move') {
      target = await placeFile(directory, name, sourceStat, (file) => fs.link(source, file)).catch(() => undefined);
    }

    if (target === undefined) target = await publishCopy(source, sourceStat, directory, name, reportBytes);
    if (target === null) return { ...result, status: 'skipped', message: '目标文件夹中已有同一个视频文件。' };

    if (mode === 'copy') return { ...result, status: 'copied', destination: target };

    const currentSource = await fs.lstat(source, { bigint: true });
    if (!unchangedFile(sourceStat, currentSource)) throw new Error('移动期间源视频发生变化，源文件已保留。');
    await fs.unlink(source);
    return { ...result, status: 'moved', destination: target };
  } catch (error) {
    const message = errorMessage(error);
    if (target) return { ...result, status: 'failed', destination: target, message: `目标文件已保留。${message}` };
    return { ...result, status: 'failed', message };
  }
}

async function videoSize(videoPath) {
  if (!videoPath) return 0;
  const stats = await fs.lstat(videoPath).catch(() => null);
  return stats?.isFile() ? stats.size : 0;
}

async function transferVideos(projects, destination, mode, onProgress) {
  if (mode !== 'copy' && mode !== 'move') throw new TypeError('无效的文件操作。');

  const sizes = await Promise.all(projects.map(project => videoSize(project.videoPath)));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const total = projects.length;
  const results = [];
  let settledBytes = 0;
  function report(current = null) {
    try {
      onProgress?.({
        completed: results.length,
        total,
        processedBytes: settledBytes + (current?.bytes ?? 0),
        totalBytes,
        current
      });
    } catch {
      // Closing the progress UI must not interrupt a file operation.
    }
  }
  report();

  let directory;
  try {
    directory = await fs.realpath(destination);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('目标路径不是文件夹。');
  } catch (error) {
    const message = errorMessage(error);
    for (const { id, title } of projects) results.push({ id, title, status: 'failed', message });
    settledBytes = totalBytes;
    report();
    return { destination, results };
  }

  for (const [index, project] of projects.entries()) {
    const size = sizes[index];
    const { id, title, videoPath } = project;
    const filename = videoPath ? path.basename(videoPath) : '';
    let reportedBytes = 0;
    let lastReport = performance.now();
    const reportCurrent = bytes => report({ id, title, filename, bytes, totalBytes: size });

    reportCurrent(0);
    const result = await transferVideo(project, directory, mode, size, bytes => {
      const now = performance.now();
      if (bytes <= reportedBytes || now - lastReport < progressIntervalMs) return;
      reportedBytes = bytes;
      lastReport = now;
      reportCurrent(bytes);
    });
    if ((result.status === 'moved' || result.status === 'copied') && reportedBytes < size) reportCurrent(size);

    results.push(result);
    settledBytes += size;
    report();
  }
  return { destination: directory, results };
}

module.exports = { transferVideos };
