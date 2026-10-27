'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 弹幕层的桥接层：只收消息和指令，单向为主。
 */
contextBridge.exposeInMainWorld('dm', {
  onItem: (callback) => {
    ipcRenderer.on('dm:item', (_event, item) => callback(item));
  },
  onCommand: (callback) => {
    ipcRenderer.on('dm:cmd', (_event, cmd) => callback(cmd));
  },
  /** 鼠标压到图片上时临时接管点击，移开再恢复穿透 */
  hover: (on) => ipcRenderer.send('dm:hover', Boolean(on)),
  /** 大图模式：整屏都要能点（点任意位置关闭） */
  modal: (open) => ipcRenderer.send('dm:modal', Boolean(open)),
  /** 主进程轮询光标位置（不依赖 forward 的 mousemove，Windows 上那个不可靠） */
  onCursor: (callback) => {
    ipcRenderer.on('dm:cursor', (_event, point) => callback(point));
  },
  /** 主进程轮询到鼠标左键按下（页面收不到 click 时兜底） */
  onClick: (callback) => {
    ipcRenderer.on('dm:click', (_event, point) => callback(point));
  },
  ready: () => ipcRenderer.send('dm:ready')
});
