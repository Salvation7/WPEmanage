const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const batchFileName = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/;

function isWorkshopId(id) {
  return typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id) && BigInt(id) <= 0xffffffffffffffffn;
}

function isAbsolutePath(value) {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value);
}

function cleanMoveResult(result, folder) {
  if (result?.status !== 'moved' || typeof result.id !== 'string' || !result.id || typeof result.title !== 'string'
    || !isAbsolutePath(result.destination) || path.dirname(result.destination).toLowerCase() !== folder.toLowerCase()) {
    return null;
  }

  const { id, title, status, destination, steamWorkshopId } = result;
  const clean = { id, title, status, destination };
  if (isWorkshopId(steamWorkshopId)) clean.steamWorkshopId = steamWorkshopId;
  return clean;
}

function cleanBatch(value, id) {
  if (value?.id !== id || !Number.isSafeInteger(value.movedAt) || value.movedAt <= 0 || value.movedAt > 8.64e15
    || !isAbsolutePath(value.destination) || !Array.isArray(value.results)) {
    return null;
  }

  const { movedAt, destination } = value;
  const results = value.results.map(result => cleanMoveResult(result, destination)).filter(Boolean);
  return results.length ? { id, movedAt, destination, results } : null;
}

function createMoveBatch(destination, results) {
  const id = randomUUID();
  return cleanBatch({ id, movedAt: Date.now(), destination, results }, id);
}

async function readMoveHistory(directory) {
  let files;
  try {
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const history = [];
  for (const file of files) {
    const id = file.isFile() && batchFileName.exec(file.name)?.[1];
    if (!id) continue;
    try {
      const batch = cleanBatch(JSON.parse(await fs.readFile(path.join(directory, file.name), 'utf8')), id);
      if (batch) history.push(batch);
    } catch (error) {
      console.warn(`无法读取移动记录 ${id}`, error);
    }
  }
  return history.sort((first, second) => second.movedAt - first.movedAt);
}

async function writeMoveBatch(directory, batch) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${batch.id}.json`);
  const temporaryFile = path.join(directory, `.${batch.id}.tmp`);
  const existing = await fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) throw new Error('此移动记录已存在。');

  const temporary = await fs.open(temporaryFile, 'wx');
  try {
    try {
      await temporary.writeFile(JSON.stringify(batch, null, 2), 'utf8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await fs.rename(temporaryFile, file);
  } catch (error) {
    await fs.unlink(temporaryFile).catch(() => {});
    throw error;
  }
}

module.exports = { isWorkshopId, createMoveBatch, readMoveHistory, writeMoveBatch };
