'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 投屏引导页：只读状态 + 一个关闭动作。 */
contextBridge.exposeInMainWorld('join', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => {
    ipcRenderer.on('state', (_event, state) => callback(state));
  },
  close: () => ipcRenderer.invoke('join:close')
});
