'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 控制面板的桥接层：只暴露必要的动作，渲染进程拿不到 Node。
 */
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },

  togglePause: () => ipcRenderer.invoke('session:togglePause'),
  clear: () => ipcRenderer.invoke('session:clear'),
  end: () => ipcRenderer.invoke('session:end'),
  restart: () => ipcRenderer.invoke('session:restart'),

  copyLink: () => ipcRenderer.invoke('app:copy'),
  exportData: () => ipcRenderer.invoke('app:export'),
  openRepo: () => ipcRenderer.invoke('app:openRepo'),
  setConfig: (patch) => ipcRenderer.invoke('app:setConfig', patch),
  setDisplay: (id) => ipcRenderer.invoke('app:setDisplay', id),
  setNic: (address) => ipcRenderer.invoke('app:setNic', address),
  refreshNetwork: () => ipcRenderer.invoke('app:refreshNetwork'),
  openNetworkSettings: () => ipcRenderer.invoke('app:openNetworkSettings'),
  toggleOverlay: () => ipcRenderer.invoke('app:toggleOverlay'),
  toggleJoin: () => ipcRenderer.invoke('app:toggleJoin'),
  setMode: (mode) => ipcRenderer.invoke('app:setMode', mode),

  getHistory: () => ipcRenderer.invoke('history:get'),
  replay: (seq) => ipcRenderer.invoke('session:replay', seq),
  onItem: (callback) => {
    ipcRenderer.on('dm:item', (_event, item) => callback(item));
  },
  importWords: () => ipcRenderer.invoke('app:importWords'),

  hidePanel: () => ipcRenderer.invoke('app:hidePanel'),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  quit: () => ipcRenderer.invoke('app:quit')
});
