const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shelf', {
  scan: () => ipcRenderer.invoke('library:scan'),
  addSource: () => ipcRenderer.invoke('library:add'),
  removeSource: path => ipcRenderer.invoke('library:remove', path),
  reveal: id => ipcRenderer.invoke('library:reveal', id),
  play: id => ipcRenderer.invoke('library:play', id),
  transfer: (ids, mode) => ipcRenderer.invoke('library:transfer', ids, mode),
  listMoveHistory: () => ipcRenderer.invoke('library:list-move-history'),
  openMoveDestination: id => ipcRenderer.invoke('library:open-move-destination', id),
  openWorkshop: id => ipcRenderer.invoke('library:open-workshop', id),
  copyWorkshopList: ids => ipcRenderer.invoke('library:copy-workshop-list', ids),
  showOutput: () => ipcRenderer.invoke('library:show-output'),
  onProgress: listener => ipcRenderer.on('library:progress', (_event, progress) => listener(progress))
});
