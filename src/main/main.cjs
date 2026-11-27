const { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { discoverSources, discoverWallpaperLauncher, scanLibrary } = require('./library.cjs');
const { isWorkshopId, createMoveBatch, readMoveHistory, writeMoveBatch } = require('./move-history.cjs');
const { transferVideos } = require('./transfer.cjs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'shelf-media',
  privileges: { standard: true, secure: true, stream: true }
}]);

const rendererFile = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
const workshopRootSuffix = path.sep + path.join('steamapps', 'workshop', 'content', '431960');
const movedWorkshops = new Map();
let moveHistory = [];
let library = new Map();
let installedWorkshops = new Map();
let workshopRoots = new Set();
let manualSources = [];
let lastDestination = '';
let scanning;
let busy = false;

function preferencesFile() {
  return path.join(app.getPath('userData'), 'library-settings.json');
}

async function loadPreferences() {
  try {
    const preferences = JSON.parse(await fs.readFile(preferencesFile(), 'utf8'));
    if (Array.isArray(preferences.sources)) {
      manualSources = preferences.sources.filter(source => typeof source === 'string' && path.isAbsolute(source));
    }
    if (typeof preferences.lastDestination === 'string') lastDestination = preferences.lastDestination;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error);
  }
}

async function savePreferences() {
  const file = preferencesFile();
  const temporaryFile = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporaryFile, JSON.stringify({ sources: manualSources, lastDestination }, null, 2));
  await fs.rename(temporaryFile, file);
}

function moveHistoryDirectory() {
  return path.join(app.getPath('userData'), 'move-history');
}

async function loadMoveHistory() {
  try {
    moveHistory = await readMoveHistory(moveHistoryDirectory());
    for (const batch of moveHistory) {
      for (const { steamWorkshopId, title } of batch.results) {
        if (steamWorkshopId && !movedWorkshops.has(steamWorkshopId)) movedWorkshops.set(steamWorkshopId, title);
      }
    }
  } catch (error) {
    console.error('无法加载移动记录。', error);
  }
}

async function saveMoveBatch(report, movedResults) {
  try {
    const batch = createMoveBatch(report.destination, movedResults);
    if (!batch) throw new Error('移动记录无效。');
    moveHistory.unshift(batch);
    await writeMoveBatch(moveHistoryDirectory(), batch);
  } catch (error) {
    console.error('无法保存移动记录。', error);
    report.historyWarning = '视频已移动，但本次记录无法保存到磁盘。';
  }
}

function installedWorkshopId(directory, workshopRoots) {
  const id = path.basename(directory);
  return workshopRoots.has(path.dirname(directory).toLowerCase()) && isWorkshopId(id) ? id : null;
}

function isInsideWorkshop(directory) {
  const canonical = directory.toLowerCase();
  return [...workshopRoots].some(root => canonical === root || canonical.startsWith(root + path.sep));
}

function workshopUrl(id) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
}

function workshopTitle(id) {
  const title = isWorkshopId(id) ? movedWorkshops.get(id) ?? installedWorkshops.get(id) : undefined;
  if (title === undefined) throw new Error('找不到对应的 Steam 创意工坊项目。');
  return title;
}

function scan() {
  if (!scanning) {
    scanning = (async () => {
      const detected = (await discoverSources()).map(source => ({ ...source, manual: false }));
      const discoveredWorkshopRoots = new Set(detected.map(source => source.path.toLowerCase())
        .filter(folder => folder.endsWith(workshopRootSuffix)));
      const sources = [...detected];
      for (const folder of manualSources) {
        if (!sources.some(source => source.path.toLowerCase() === folder.toLowerCase())) {
          sources.push({ path: folder, label: '自选目录', manual: true });
        }
      }
      const scanned = await scanLibrary(sources);
      const projects = scanned.projects.map(project => ({
        ...project,
        steamWorkshopId: installedWorkshopId(project.directory, discoveredWorkshopRoots)
      }));
      library = new Map(projects.map(project => [project.id, project]));
      workshopRoots = discoveredWorkshopRoots;
      installedWorkshops = new Map(projects.filter(project => project.steamWorkshopId)
        .map(project => [project.steamWorkshopId, project.title]));
      return {
        projects: projects.map(project => ({
          ...project,
          previewUrl: project.previewPath ? `shelf-media://preview/${encodeURIComponent(project.id)}` : null,
          videoUrl: project.videoPath ? `shelf-media://video/${encodeURIComponent(project.id)}` : null,
          filename: project.videoPath ? path.basename(project.videoPath) : ''
        })),
        sources,
        issues: scanned.issues
      };
    })().finally(() => { scanning = undefined; });
  }
  return scanning;
}

function chooseFolder(event, title, defaultPath) {
  return dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title,
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择此文件夹'
  });
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.senderFrame?.url !== rendererUrl) throw new Error('请求来源无效');
    return callback(event, ...args);
  });
}

function withLibraryChange(callback) {
  return async (...args) => {
    if (busy) throw new Error('有一项文件操作正在进行，请稍后重试。');
    busy = true;
    try {
      if (scanning) await scanning;
      return await callback(...args);
    } finally {
      busy = false;
    }
  };
}

function registerActions() {
  handle('library:scan', () => {
    if (busy) throw new Error('文件操作完成后可重新扫描。');
    return scan();
  });

  handle('library:add', withLibraryChange(async event => {
    const { canceled, filePaths } = await chooseFolder(event, '添加壁纸项目或 Steam 库目录');
    if (canceled) return null;
    const folder = await fs.realpath(filePaths[0]);
    if (!manualSources.some(source => source.toLowerCase() === folder.toLowerCase())) {
      manualSources.push(folder);
      await savePreferences();
    }
    return scan();
  }));

  handle('library:remove', withLibraryChange(async (_event, folder) => {
    manualSources = manualSources.filter(source => source !== folder);
    await savePreferences();
    return scan();
  }));

  handle('library:reveal', async (_event, id) => {
    const project = library.get(id);
    if (!project) return;
    if (project.videoPath) shell.showItemInFolder(project.videoPath);
    else {
      const error = await shell.openPath(project.directory);
      if (error) throw new Error('无法打开项目目录。');
    }
  });

  handle('library:play', async (_event, id) => {
    const video = library.get(id)?.videoPath;
    if (video && await shell.openPath(video)) throw new Error('无法用系统播放器打开此视频。');
  });

  handle('library:show-output', async () => {
    if (lastDestination && await shell.openPath(lastDestination)) throw new Error('无法打开目标文件夹。');
  });

  handle('library:list-move-history', () => moveHistory);

  handle('library:open-move-destination', async (_event, id) => {
    const batch = moveHistory.find(batch => batch.id === id);
    const info = batch && await fs.stat(batch.destination).catch(() => null);
    if (!info?.isDirectory()) throw new Error('找不到这次移动的目标文件夹。');
    if (await shell.openPath(batch.destination)) throw new Error('无法打开这次移动的目标文件夹。');
  });

  handle('library:open-workshop', async (_event, id) => {
    workshopTitle(id);
    await shell.openExternal(workshopUrl(id));
  });

  handle('library:open-wallpaper-engine', async () => {
    const executable = await discoverWallpaperLauncher();
    if (!executable) throw new Error('在当前 Steam 库中找不到 Wallpaper Engine 的启动程序。');
    await new Promise((resolve, reject) => {
      const launcher = spawn(executable, [], { cwd: path.dirname(executable), detached: true, stdio: 'ignore' });
      launcher.once('error', () => reject(new Error('无法启动 Wallpaper Engine。')));
      launcher.once('spawn', () => {
        launcher.unref();
        resolve();
      });
    });
  });

  handle('library:copy-workshop-list', (_event, ids) => {
    if (!Array.isArray(ids)) throw new Error('创意工坊项目清单无效。');
    const entries = [...new Set(ids)].map(id => `${workshopTitle(id).replace(/\s+/g, ' ').trim()}\t${id}\t${workshopUrl(id)}`);
    if (entries.length) clipboard.writeText(entries.join('\r\n'));
    return entries.length;
  });

  handle('library:transfer', withLibraryChange(async (event, ids, mode) => {
    if (!Array.isArray(ids) || !['copy', 'move'].includes(mode)) throw new Error('文件操作无效。');
    const projects = [...new Set(ids)].map(id => library.get(id)).filter(project => project?.videoPath);
    if (!projects.length) throw new Error('所选项目没有可用的视频文件。');

    const verb = mode === 'move' ? '移动' : '复制';
    const { canceled, filePaths } = await chooseFolder(event, `${verb}视频到文件夹`, lastDestination);
    if (canceled) return null;
    const destination = filePaths[0];

    if (mode === 'move') {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
        type: 'warning',
        title: '确认移动原视频',
        message: `移动 ${projects.length} 个视频到选定目录？`,
        detail: `移动后项目目录中的原视频将被移除，对应壁纸可能无法在 Wallpaper Engine 中播放。\n\n目标：${destination}`,
        buttons: ['取消', '移动视频'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (response !== 1) return null;
    }

    const sendProgress = progress => {
      if (!event.sender.isDestroyed()) event.sender.send('library:progress', { ...progress, destination });
    };
    const report = await transferVideos(projects, destination, mode, sendProgress);
    const exportedOutsideWorkshop = !isInsideWorkshop(report.destination);
    lastDestination = destination;
    try {
      await savePreferences();
    } catch (error) {
      console.error(error);
    }
    const movedResults = report.results.filter(result => result.status === 'moved');
    for (const { id } of movedResults) {
      const project = library.get(id);
      library.set(id, { ...project, videoPath: null });
    }
    if (exportedOutsideWorkshop && movedResults.length) {
      // Loose-video projects can have several files under one Workshop subscription.
      const workshopsWithVideos = new Set([...library.values()].filter(project => project.videoPath && project.steamWorkshopId)
        .map(project => project.steamWorkshopId));
      for (const result of movedResults) {
        const project = library.get(result.id);
        if (!project.steamWorkshopId || workshopsWithVideos.has(project.steamWorkshopId)) continue;
        const directory = await fs.realpath(project.directory).catch(() => null);
        if (directory?.toLowerCase() === project.directory.toLowerCase()) {
          result.steamWorkshopId = project.steamWorkshopId;
          movedWorkshops.set(result.steamWorkshopId, project.title);
        }
      }
    }
    if (movedResults.length) await saveMoveBatch(report, movedResults);
    return report;
  }));
}

async function serveMedia(request) {
  const url = new URL(request.url);
  const project = library.get(decodeURIComponent(url.pathname.slice(1)));
  const file = { preview: project?.previewPath, video: project?.videoPath }[url.hostname];
  if (typeof file !== 'string' || !['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 404 });
  }
  try {
    return await net.fetch(pathToFileURL(file).href, { method: request.method, headers: request.headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function createWindow() {
  const window = new BrowserWindow({
    title: '壁纸库 · Wallpaper Shelf',
    width: 1512,
    height: 960,
    minWidth: 850,
    minHeight: 540,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101512',
    icon: path.join(__dirname, '..', 'renderer', 'app-icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#131a16', symbolColor: '#d5dfd9', height: 57 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (busy) event.preventDefault();
  });
  window.loadFile(rendererFile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    await Promise.all([loadPreferences(), loadMoveHistory()]);
    protocol.handle('shelf-media', serveMedia);
    registerActions();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
