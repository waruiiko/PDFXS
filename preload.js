const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:          ()               => ipcRenderer.invoke('dialog:openFile'),
  readFile:          (fp)             => ipcRenderer.invoke('file:read', fp),
  saveProgress:      (fp, page, zoom) => ipcRenderer.invoke('progress:save', fp, page, zoom),
  loadProgress:      (fp)             => ipcRenderer.invoke('progress:load', fp),
  saveAnnotations:   (fp, data)       => ipcRenderer.invoke('annotations:save', fp, data),
  loadAnnotations:   (fp)             => ipcRenderer.invoke('annotations:load', fp),
  showSaveDialog:    (opts)           => ipcRenderer.invoke('dialog:saveFile', opts),
  writeFile:         (fp, content)    => ipcRenderer.invoke('file:write', fp, content),
  loadRecent:        ()               => ipcRenderer.invoke('recent:load'),
  addRecent:         (fp)             => ipcRenderer.invoke('recent:add', fp),
  removeRecent:      (fp)             => ipcRenderer.invoke('recent:remove', fp),

  confirmQuit:    ()              => ipcRenderer.invoke('app:quit'),
  onAppClose:     (cb) => ipcRenderer.on('app-close',       ()         => cb()),

  onOpenFile:     (cb) => ipcRenderer.on('open-file',       (_, fp)    => cb(fp)),
  onNewTab:       (cb) => ipcRenderer.on('new-tab',         ()         => cb()),
  onZoomIn:       (cb) => ipcRenderer.on('zoom-in',         ()         => cb()),
  onZoomOut:      (cb) => ipcRenderer.on('zoom-out',        ()         => cb()),
  onZoomFit:      (cb) => ipcRenderer.on('zoom-fit',        ()         => cb()),
  onPrevPage:     (cb) => ipcRenderer.on('prev-page',       ()         => cb()),
  onNextPage:     (cb) => ipcRenderer.on('next-page',       ()         => cb()),
  onToggleToc:    (cb) => ipcRenderer.on('toggle-toc',      ()         => cb()),
  onToggleSearch: (cb) => ipcRenderer.on('toggle-search',   ()         => cb()),
  onHighlight:    (cb) => ipcRenderer.on('highlight',       (_, color) => cb(color)),
  onOpenSig:      (cb) => ipcRenderer.on('open-signature',  ()         => cb()),
  onNightMode:    (cb) => ipcRenderer.on('night-mode',      ()         => cb()),
});
