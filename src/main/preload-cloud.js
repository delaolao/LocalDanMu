'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 词云大屏的桥接层：只读状态 + 增量消息 + 历史。 */
contextBridge.exposeInMainWorld('cloud', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => {
    ipcRenderer.on('state', (_event, state) => callback(state));
  },
  getHistory: () => ipcRenderer.invoke('history:get'),
  onItem: (callback) => {
    ipcRenderer.on('dm:item', (_event, item) => callback(item));
  }
});
