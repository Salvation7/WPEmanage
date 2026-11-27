const $ = id => document.getElementById(id);
const api = window.shelf;
const categories = {
  all: { title: '全部壁纸', label: '全部壁纸', icon: 'grid' },
  video: { title: '视频壁纸', label: '视频', icon: 'video' },
  missing: { title: '视频缺失', label: '视频缺失', icon: 'info' },
  scene: { title: '场景壁纸', label: '场景', icon: 'scene' },
  web: { title: '网页壁纸', label: '网页', icon: 'web' },
  application: { title: '应用壁纸', label: '应用', icon: 'application' },
  unknown: { title: '其他壁纸', label: '其他', icon: 'unknown' }
};
const state = {
  projects: [], byId: new Map(), sources: [], issues: [], visible: [], selected: new Set(),
  kind: 'all', focus: '', anchor: '', busy: true, transfer: null, loaded: false, error: '', progress: ''
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const projectKind = project => categories[project.kind] || categories.unknown;
const isMissingVideo = project => project.kind === 'video' && !project.videoPath;
const inCategory = (project, kind) => kind === 'missing' ? isMissingVideo(project) : kind === 'all' || project.kind === kind;
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
let toastTimer;

function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = bytes ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / (1024 ** unit)).toLocaleString('zh-CN', { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

function art(project, detail = false) {
  const { format, kind, previewUrl, videoUrl } = project;
  return `<div class="art" data-kind="${escape(kind)}">
    <span data-icon="${projectKind(project).icon}" aria-hidden="true"></span>
    ${previewUrl ? `<img src="${escape(previewUrl)}" alt="" ${detail ? '' : 'loading="lazy" draggable="false"'} decoding="async">` : ''}
    <span class="format-chip">${escape(format || '未知')}</span>
    ${detail && videoUrl ? '<button class="icon-button play-button" data-icon="play" data-action="preview" title="预览视频" aria-label="预览视频"></button>' : ''}
  </div>`;
}

function renderNavigation() {
  const counts = { all: state.projects.length, missing: 0 };
  for (const project of state.projects) {
    counts[project.kind] = (counts[project.kind] || 0) + 1;
    if (isMissingVideo(project)) counts.missing++;
  }
  $('categories').innerHTML = Object.entries(categories).map(([kind, category]) => `<button class="nav-item" data-kind="${kind}" data-icon="${category.icon}" aria-current="${kind === state.kind}" title="${category.title}" aria-label="${category.title}"><span class="nav-text">${category.label}</span><span class="nav-count">${counts[kind] || 0}</span></button>`).join('');
  $('source-count').textContent = state.sources.length;
}

function updateStatus() {
  const hasIssues = Boolean(state.error || state.issues.length);
  $('rescan').disabled = state.busy;
  $('add-source').disabled = state.busy;
  $('source-settings').disabled = state.busy;
  $('move-history').disabled = state.busy;
  const emptyAdd = $('empty').querySelector('[data-action="add"]');
  if (emptyAdd) emptyAdd.disabled = state.busy;
  const statusButton = $('scan-status');
  const transfer = state.transfer;
  statusButton.disabled = !transfer && (!hasIssues || state.busy);
  statusButton.classList.toggle('has-issues', !transfer && hasIssues);
  statusButton.classList.toggle('has-transfer', Boolean(transfer));
  const label = transfer ? `传输 ${transfer.completed} / ${transfer.total}`
    : state.busy ? state.progress || '正在扫描' : hasIssues ? '查看扫描提示' : '扫描完成';
  $('scan-label').textContent = label;
  const actionLabel = transfer ? `查看传输进度（${label}）` : label;
  statusButton.title = actionLabel;
  statusButton.setAttribute('aria-label', actionLabel);
}

function updateFormat() {
  const picker = $('format');
  const previous = picker.value;
  const pool = state.projects.filter(project => inCategory(project, state.kind));
  const formats = [...new Set(pool.map(project => project.format).filter(Boolean))].sort(collator.compare);
  picker.replaceChildren(new Option('全部格式', ''), ...formats.map(format => new Option(format, format)));
  if (formats.includes(previous)) picker.value = previous;
}

function matchingProjects() {
  const tokens = $('search').value.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const format = $('format').value;
  const kind = state.kind;
  const result = state.projects.filter(project => {
    if (!inCategory(project, kind) || (format && format !== project.format)) return false;
    const target = [project.title, project.format, project.workshopId, project.filename, projectKind(project).label].join(' ').toLowerCase();
    return tokens.every(token => target.includes(token));
  });
  const nameOrder = (first, second) => collator.compare(first.title, second.title);
  switch ($('sort').value) {
    case 'name': return result.sort(nameOrder);
    case 'size': return result.sort((first, second) => second.size - first.size || nameOrder(first, second));
    default: return result.sort((first, second) => second.modifiedAt - first.modifiedAt || nameOrder(first, second));
  }
}

function renderCollection(resetScroll = false) {
  marquee.cancel();
  state.visible = matchingProjects();
  const shownIds = new Set(state.visible.map(project => project.id));
  if (!shownIds.has(state.focus)) state.focus = state.visible[0]?.id || '';
  if (!shownIds.has(state.anchor)) state.anchor = '';
  $('page-title').textContent = categories[state.kind].title;
  $('item-count').textContent = state.loaded ? `${state.visible.length} 个项目` : '';
  const grid = $('projects');
  const collection = $('collection');
  const scrollTop = collection.scrollTop;
  grid.innerHTML = state.visible.map(project => `<article class="project" data-id="${escape(project.id)}">
    <button class="project-open" type="button" title="${escape(project.title)}" aria-label="查看 ${escape(project.title)} 的详情">
      ${art(project)}
      <span class="project-caption"><span class="project-title">${escape(project.title)}</span><span class="project-meta">${projectKind(project).label} · ${isMissingVideo(project) ? '视频缺失' : fileSize(project.size)}</span></span>
    </button>
    <label class="project-check" title="选择项目"><input tabindex="-1" type="checkbox" aria-label="选择 ${escape(project.title)}"></label>
  </article>`).join('');
  if (!state.loaded && state.busy) grid.innerHTML = '<div class="skeleton" aria-hidden="true"></div>'.repeat(12);
  collection.scrollTop = resetScroll ? 0 : scrollTop;

  const empty = $('empty');
  empty.hidden = Boolean(state.visible.length || (!state.loaded && state.busy));
  if (!empty.hidden) {
    const filtered = state.projects.length > 0;
    empty.innerHTML = `<span class="empty-mark" data-icon="${filtered ? 'search' : 'folder'}" aria-hidden="true"></span>
      <h2>${filtered ? '没有匹配的壁纸' : '未找到本地壁纸'}</h2>
      <p>${filtered ? '试试其他关键词，或清除当前筛选。' : '选择 Wallpaper Engine 项目目录或 Steam 库文件夹。'}</p>
      <button class="button primary" data-action="${filtered ? 'reset' : 'add'}" ${state.busy ? 'disabled' : ''}>${filtered ? '清除筛选' : '添加目录'}</button>`;
  }
  renderDetails();
  updateSelection();
}

function renderDetails() {
  const details = $('details');
  const project = state.byId.get(state.focus);
  if (!project) {
    details.innerHTML = `<p class="details-placeholder">${state.busy && !state.loaded ? '正在读取本地项目…' : '选择一个方格以查看项目。'}</p>`;
    return;
  }
  const rows = [
    ['文件格式', project.format || '未知'],
    ['文件大小', isMissingVideo(project) ? '—' : fileSize(project.size)],
    ['修改时间', project.modifiedAt ? dateFormat.format(project.modifiedAt) : '—'],
    ['来源', project.source],
    ['项目 ID', project.workshopId, 'mono'],
    ['视频文件', project.filename, 'mono'],
    ['项目目录', project.directory, 'mono']
  ];
  details.innerHTML = `${art(project, true)}
    <h3 class="detail-title">${escape(project.title)}</h3>
    <p class="detail-type">${projectKind(project).title}</p>
    <div class="detail-actions">
      ${project.videoPath ? '<button class="button primary" data-icon="copy" data-action="copy">复制视频</button><button class="button" data-icon="cut" data-action="move">移动视频</button>' : ''}
      <button class="button reveal" data-icon="folder" data-action="reveal">${project.videoPath ? '定位视频文件' : '打开项目目录'}</button>
      ${project.steamWorkshopId ? `<button class="button reveal" data-icon="external" data-action="workshop" data-workshop-id="${escape(project.steamWorkshopId)}">在 Steam 创意工坊打开</button>` : ''}
    </div>
    ${isMissingVideo(project) ? '<p class="detail-notice">项目声明的视频文件已缺失。</p>' : ''}
    <dl class="metadata">${rows.filter(([, value]) => value).map(([label, value, style]) => `<div><dt>${label}</dt><dd class="${style || ''}">${escape(value)}</dd></div>`).join('')}</dl>`;
  details.scrollTop = 0;
}

function updateSelection() {
  let physicalFiles = 0;
  for (const id of state.selected) if (state.byId.get(id)?.videoPath) physicalFiles++;
  let visibleSelected = 0;
  for (const card of $('projects').querySelectorAll('.project')) {
    const id = card.dataset.id;
    const checked = state.selected.has(id);
    const focused = id === state.focus;
    if (checked) visibleSelected++;
    card.classList.toggle('selected', checked);
    card.classList.toggle('focused', focused);
    card.querySelector('input').checked = checked;
    const button = card.querySelector('.project-open');
    button.tabIndex = focused ? 0 : -1;
    button.setAttribute('aria-pressed', checked);
  }
  $('select-all').disabled = !state.visible.length;
  $('select-all').checked = Boolean(state.visible.length && visibleSelected === state.visible.length);
  $('select-all').indeterminate = visibleSelected > 0 && !$('select-all').checked;
  $('selection-summary').textContent = `已选 ${state.selected.size} 项${state.selected.size ? ` · ${physicalFiles} 个视频` : ''}`;
  $('clear-selection').hidden = !state.selected.size;
  $('copy-workshop-selection').hidden = state.kind !== 'missing' || !selectedWorkshopIds().length;
  $('batch-copy').disabled = $('batch-move').disabled = state.busy || !physicalFiles;
  for (const button of $('details').querySelectorAll('[data-action="copy"], [data-action="move"]')) button.disabled = state.busy;
}

function focusProject(id) {
  if (state.focus !== id) {
    state.focus = id;
    renderDetails();
  }
  updateSelection();
}

function chooseProject(id, { additive = false, range = false, checked = true } = {}) {
  if (!additive) state.selected.clear();
  const anchor = range ? state.anchor || state.focus || id : id;
  const start = state.visible.findIndex(project => project.id === anchor);
  const end = state.visible.findIndex(project => project.id === id);
  for (const project of state.visible.slice(Math.min(start, end), Math.max(start, end) + 1)) {
    if (checked) state.selected.add(project.id);
    else state.selected.delete(project.id);
  }
  state.anchor = anchor;
  focusProject(id);
}

function clearSelection() {
  state.selected.clear();
  state.anchor = '';
  updateSelection();
}

function selectVisible(selected) {
  for (const { id } of state.visible) {
    if (selected) state.selected.add(id);
    else state.selected.delete(id);
  }
  updateSelection();
}

function focusCardButton(id) {
  const button = $('projects').querySelector(`.project[data-id="${CSS.escape(id)}"] .project-open`);
  button?.focus({ preventScroll: true });
  return button;
}

function navigateGrid(event, card, additive) {
  const current = state.visible.findIndex(project => project.id === card.dataset.id);
  const last = state.visible.length - 1;
  const columns = getComputedStyle($('projects')).gridTemplateColumns.split(' ').length;
  const targets = {
    ArrowLeft: current - 1, ArrowRight: current + 1,
    ArrowUp: current >= columns ? current - columns : current,
    ArrowDown: Math.floor(current / columns) < Math.floor(last / columns) ? current + columns : current,
    Home: 0, End: last
  };
  const index = targets[event.key];
  if (index === undefined) return;
  event.preventDefault();
  const { id } = state.visible[Math.max(0, Math.min(last, index))];
  if (additive && !event.shiftKey) focusProject(id);
  else chooseProject(id, { additive, range: event.shiftKey });
  focusCardButton(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function changeCategory(kind) {
  state.kind = kind;
  for (const button of $('categories').querySelectorAll('button')) button.setAttribute('aria-current', button.dataset.kind === kind);
  updateFormat();
  renderCollection(true);
}

function ingest(snapshot) {
  if (!snapshot) return;
  marquee.cancel();
  state.loaded = true;
  state.error = '';
  state.projects = snapshot.projects;
  state.byId = new Map(state.projects.map(project => [project.id, project]));
  state.sources = snapshot.sources;
  state.issues = snapshot.issues;
  state.selected = new Set([...state.selected].filter(id => state.byId.has(id)));
  renderNavigation();
  updateFormat();
  renderCollection();
}

function toast(message) {
  clearTimeout(toastTimer);
  const modal = $('modal').open;
  const target = modal ? $('modal-feedback') : $('toast');
  (modal ? $('toast') : $('modal-feedback')).hidden = true;
  target.textContent = message;
  target.hidden = false;
  toastTimer = setTimeout(() => { target.hidden = true; }, 6500);
}

const errorMessage = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /u, '');

async function load(action, progress = '正在扫描') {
  marquee.cancel();
  state.busy = true;
  state.progress = progress;
  updateStatus();
  updateSelection();
  try {
    return ingest(await action());
  } catch (error) {
    state.error = errorMessage(error);
    toast(state.error);
  } finally {
    state.busy = false;
    updateStatus();
    if (!state.loaded) renderCollection();
    else updateSelection();
  }
}

function showModal(title, html, buttons = []) {
  $('modal-title').textContent = title;
  $('modal-content').innerHTML = html;
  $('modal-feedback').hidden = true;
  const actions = $('modal-actions');
  actions.replaceChildren();
  for (const { label, action, primary } of buttons) {
    const button = document.createElement('button');
    button.className = primary ? 'button primary' : 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    actions.append(button);
  }
  if (!$('modal').open) $('modal').showModal();
}

function manageSources() {
  const items = state.sources.map((source, index) => `<li><div>${escape(source.label)}<small>${escape(source.path)}</small></div>${source.manual ? `<button class="text-button" data-remove="${index}">移出库</button>` : '<span class="result-status">自动发现</span>'}</li>`).join('');
  showModal('库目录', items ? `<ul class="modal-list">${items}</ul>` : '<p>还没有可扫描的目录。</p>', [
    { label: '添加目录', primary: true, action: async () => {
      $('modal').close();
      await load(api.addSource, '选择目录');
    } }
  ]);
  for (const button of $('modal-content').querySelectorAll('[data-remove]')) {
    button.addEventListener('click', async () => {
      const source = state.sources[button.dataset.remove];
      $('modal').close();
      await load(() => api.removeSource(source.path));
      manageSources();
    });
  }
}

function showIssues() {
  const details = [state.error, ...state.issues].filter(Boolean);
  showModal('扫描提示', `<ul class="modal-list">${details.map(issue => `<li>${escape(issue)}</li>`).join('')}</ul>`);
}

function updateTransferProgress() {
  const { completed, total, processedBytes, totalBytes, current, destination } = state.transfer;
  const fraction = totalBytes ? processedBytes / totalBytes : completed / total;
  const percent = Math.min(100, fraction * 100);
  $('transfer-progress-overall').value = percent;
  $('transfer-progress-percent').textContent = `${Math.floor(percent)}%`;
  $('transfer-progress-count').textContent = `已处理 ${completed} / ${total} 个文件`;
  $('transfer-progress-bytes').textContent = `${fileSize(processedBytes)} / ${fileSize(totalBytes)}`;
  $('transfer-progress-destination').hidden = !destination;
  $('transfer-progress-path').textContent = destination;

  $('transfer-progress-file-panel').hidden = !current;
  const activity = $('transfer-progress-activity');
  activity.hidden = Boolean(current);
  if (current) {
    $('transfer-progress-file').textContent = current.filename;
    $('transfer-progress-file-index').textContent = `${completed + 1} / ${total}`;
    $('transfer-progress-current').value = current.totalBytes ? Math.min(100, current.bytes / current.totalBytes * 100) : 0;
    $('transfer-progress-file-bytes').textContent = `${fileSize(current.bytes)} / ${fileSize(current.totalBytes)}`;
  } else {
    activity.textContent = completed === total ? '正在整理传输结果…' : '正在准备文件…';
  }
}

function showTransferProgress() {
  marquee.cancel();
  updateTransferProgress();
  $('transfer-progress').showModal();
}

function selectedWorkshopIds() {
  return state.visible.filter(project => state.selected.has(project.id) && project.steamWorkshopId)
    .map(project => project.steamWorkshopId);
}

async function copyWorkshopList(ids) {
  await safely(async () => {
    const count = await api.copyWorkshopList(ids);
    if (count) toast(`已复制 ${count} 个工坊项目的清单`);
  });
}

function showTransferReport(report, mode, fromHistory = false) {
  const labels = { copied: '已复制', moved: '已移动', skipped: '已跳过', failed: '失败' };
  const completed = report.results.filter(result => ['copied', 'moved'].includes(result.status)).length;
  const heading = fromHistory ? '移动记录详情' : `${mode === 'copy' ? '复制' : '移动'}结果`;
  const workshopIds = [...new Set(report.results.filter(result => result.status === 'moved' && result.steamWorkshopId).map(result => result.steamWorkshopId))];
  const remainingLinks = new Set(workshopIds);
  const items = report.results.map(result => {
    const id = result.steamWorkshopId;
    const workshopLink = result.status === 'moved' && remainingLinks.delete(id)
      ? `<button class="text-button workshop-link" data-icon="external" data-workshop-id="${escape(id)}">创意工坊 ${escape(id)}</button>` : '';
    return `<li><div><strong>${escape(result.title)}</strong><small>${escape(result.message || result.destination || '')}</small>${workshopLink}</div><span class="result-status ${['skipped', 'failed'].includes(result.status) ? 'incomplete' : ''}">${labels[result.status] || '未知'}</span></li>`;
  }).join('');
  const workshopSummary = workshopIds.length
    ? `<p class="workshop-summary">本批移出 ${workshopIds.length} 个创意工坊项目。可在 Wallpaper Engine「已安装」中按住 Ctrl 多选对应项目，再右键「取消订阅」。</p>` : '';
  const openDestination = fromHistory ? () => api.openMoveDestination(report.id) : api.showOutput;
  const actions = [{ label: '打开目标目录', action: () => safely(openDestination) }];
  if (workshopIds.length) actions.push({ label: '复制工坊清单', action: () => copyWorkshopList(workshopIds) });
  actions.push({ label: fromHistory ? '返回记录' : '完成', action: fromHistory ? showMoveHistory : () => $('modal').close(), primary: true });
  const timestamp = fromHistory ? ` · ${dateFormat.format(report.movedAt)}` : '';
  const warning = report.historyWarning ? `<p class="detail-notice">${escape(report.historyWarning)}</p>` : '';
  showModal(heading, `<p>成功 ${completed} / ${report.results.length} 个视频${timestamp}</p><p class="modal-path">${escape(report.destination)}</p>${workshopSummary}${warning}<ul class="modal-list">${items}</ul>`, actions);
}

async function showMoveHistory() {
  await safely(async () => {
    const batches = await api.listMoveHistory();
    const byId = new Map(batches.map(batch => [batch.id, batch]));
    const rows = batches.map(batch => {
      const workshops = new Set(batch.results.map(result => result.steamWorkshopId).filter(Boolean)).size;
      const quantity = `${batch.results.length} 个视频${workshops ? ` · ${workshops} 个创意工坊项目` : ''}`;
      return `<li><div><strong>${dateFormat.format(batch.movedAt)} · ${quantity}</strong><small>${escape(batch.destination)}</small></div><button class="button" data-move-batch-id="${escape(batch.id)}">查看批次</button></li>`;
    }).join('');
    showModal('移动记录', rows ? `<ul class="modal-list history-list">${rows}</ul>` : '<p>移动视频后，成功的项目会显示在这里。</p>', [
      { label: '关闭', action: () => $('modal').close(), primary: true }
    ]);
    for (const button of $('modal-content').querySelectorAll('[data-move-batch-id]')) {
      button.addEventListener('click', () => showTransferReport(byId.get(button.dataset.moveBatchId), 'move', true));
    }
  });
}

async function transfer(ids, mode) {
  if (state.busy) return;
  marquee.cancel();
  const videos = ids.filter(id => state.byId.get(id)?.videoPath);
  if (!videos.length) return;
  const currentVideo = $('details').querySelector('video');
  if (currentVideo) {
    currentVideo.pause();
    currentVideo.removeAttribute('src');
    currentVideo.load();
    renderDetails();
  }
  state.busy = true;
  const totalBytes = videos.reduce((sum, id) => sum + state.byId.get(id).size, 0);
  state.transfer = { completed: 0, total: videos.length, processedBytes: 0, totalBytes, current: null, destination: '' };
  updateStatus();
  updateSelection();
  let report;
  try {
    report = await api.transfer(videos, mode);
    if (report && mode === 'move') {
      try { ingest(await api.scan()); }
      catch (error) { toast(errorMessage(error)); }
    }
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    state.busy = false;
    state.transfer = null;
    if ($('transfer-progress').open) $('transfer-progress').close();
    updateStatus();
    updateSelection();
  }
  if (report) {
    marquee.cancel();
    showTransferReport(report, mode);
  }
}

function preview(project) {
  const wrapper = $('details').querySelector('.art');
  const video = document.createElement('video');
  video.controls = true;
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.src = project.videoUrl;
  video.addEventListener('error', () => {
    const fallback = document.createElement('div');
    fallback.className = 'media-error';
    const button = document.createElement('button');
    button.className = 'button';
    button.dataset.action = 'play';
    button.dataset.icon = 'external';
    button.textContent = '使用系统播放器';
    fallback.append(button);
    video.replaceWith(fallback);
  }, { once: true });
  wrapper.querySelector('.play-button').remove();
  wrapper.append(video);
}

async function safely(action) {
  try { await action(); }
  catch (error) { toast(errorMessage(error)); }
}

const marquee = createMarquee({
  collection: $('collection'),
  grid: $('projects'),
  box: $('selection-rectangle'),
  canStart: () => state.visible.length > 0,
  getSelection: () => state.selected,
  applySelection: selected => {
    state.selected = selected;
    updateSelection();
  },
  finishSelection: hits => {
    const firstHit = [...hits].find(id => state.selected.has(id));
    if (!firstHit) {
      if (!state.selected.size) state.anchor = '';
      return;
    }
    const id = state.selected.has(state.focus) ? state.focus : firstHit;
    state.anchor = id;
    focusProject(id);
    focusCardButton(id);
  }
});

$('categories').addEventListener('click', event => {
  const button = event.target.closest('button[data-kind]');
  if (button) changeCategory(button.dataset.kind);
});
$('collection').addEventListener('click', event => {
  const card = event.target.closest('.project');
  const additive = event.ctrlKey || event.metaKey;
  if (!card) {
    if (!additive && !event.shiftKey && !event.target.closest('button')) clearSelection();
    return;
  }
  const id = card.dataset.id;
  if (event.target.matches('input[type="checkbox"]')) {
    chooseProject(id, { additive: true, range: event.shiftKey, checked: event.target.checked });
  } else if (!event.target.closest('.project-check')) {
    chooseProject(id, { additive, range: event.shiftKey, checked: event.shiftKey || !additive || !state.selected.has(id) });
    focusCardButton(id);
  }
});
document.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement) event.target.hidden = true;
}, true);
$('details').addEventListener('click', event => {
  const action = event.target.closest('button')?.dataset.action;
  const project = state.byId.get(state.focus);
  if (!project) return;
  if (action === 'copy' || action === 'move') transfer([project.id], action);
  if (action === 'reveal') safely(() => api.reveal(project.id));
  if (action === 'workshop') safely(() => api.openWorkshop(project.steamWorkshopId));
  if (action === 'preview') preview(project);
  if (action === 'play') safely(() => api.play(project.id));
});
$('modal-content').addEventListener('click', event => {
  const button = event.target.closest('button[data-workshop-id]');
  if (button) safely(() => api.openWorkshop(button.dataset.workshopId));
});
$('empty').addEventListener('click', event => {
  if (event.target.dataset.action === 'add') load(api.addSource, '选择目录');
  if (event.target.dataset.action === 'reset') {
    $('search').value = $('format').value = '';
    changeCategory('all');
  }
});

$('search').addEventListener('input', () => renderCollection(true));
$('sort').addEventListener('change', () => renderCollection(true));
$('format').addEventListener('change', () => renderCollection(true));
$('select-all').addEventListener('change', event => selectVisible(event.target.checked));
$('clear-selection').addEventListener('click', clearSelection);
$('copy-workshop-selection').addEventListener('click', () => copyWorkshopList(selectedWorkshopIds()));
$('rescan').addEventListener('click', () => load(api.scan));
$('add-source').addEventListener('click', () => load(api.addSource, '选择目录'));
$('move-history').addEventListener('click', showMoveHistory);
$('source-settings').addEventListener('click', manageSources);
$('scan-status').addEventListener('click', () => {
  if (state.transfer) showTransferProgress();
  else showIssues();
});
$('batch-move').addEventListener('click', () => transfer([...state.selected], 'move'));
$('batch-copy').addEventListener('click', () => transfer([...state.selected], 'copy'));
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.altKey || $('modal').open || $('transfer-progress').open || !$('selection-rectangle').hidden) return;
  const additive = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (additive && key === 'k') {
    event.preventDefault();
    $('search').focus();
    $('search').select();
    return;
  }
  if (event.key === 'F5') {
    event.preventDefault();
    if (!state.busy) load(api.scan);
    return;
  }
  if (event.target.closest('input:not([type="checkbox"]), select, video, .metadata, [contenteditable]')) return;
  if (event.key === 'Escape' && state.selected.size) {
    event.preventDefault();
    clearSelection();
    return;
  }
  if (additive && key === 'a') {
    event.preventDefault();
    state.selected.clear();
    selectVisible(true);
    return;
  }
  const card = event.target.closest('.project');
  if (!card) return;
  if (event.code === 'Space' && (additive || event.shiftKey)) {
    event.preventDefault();
    if (!event.repeat) chooseProject(card.dataset.id, {
      additive, range: event.shiftKey, checked: event.shiftKey || !state.selected.has(card.dataset.id)
    });
    return;
  }
  navigateGrid(event, card, additive);
});

if (api) {
  api.onProgress(progress => {
    if (!state.transfer) return;
    state.transfer = progress;
    updateStatus();
    if ($('transfer-progress').open) updateTransferProgress();
  });
  renderNavigation();
  renderCollection();
  load(api.scan);
}
