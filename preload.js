const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  getDownloadsDir: () => ipcRenderer.invoke('get-downloads-dir'),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  revealInExplorer: (filePath) => ipcRenderer.invoke('reveal-in-explorer', filePath),

  // Conversion
  startConversion: (job) => ipcRenderer.invoke('start-conversion', job),
  cancelConversion: (fileId) => ipcRenderer.invoke('cancel-conversion', fileId),

  // Events from main process
  onConversionProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('conversion-progress', handler)
    return () => ipcRenderer.removeListener('conversion-progress', handler)
  },

  // Window controls
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),

  // Platform info
  platform: process.platform,
})
