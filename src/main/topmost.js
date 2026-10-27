'use strict';

/**
 * Windows 置顶加固
 *
 * 背景：Electron 的 setAlwaysOnTop(true) 在窗口已经处于置顶状态时基本是空操作，
 * 而 WPS / PowerPoint 放映会把自己的全屏窗口设成置顶并激活，此时弹幕层会被压到下面。
 * 实测直接用 user32 的 SetWindowPos(HWND_TOPMOST) 才能把它重新顶上去。
 *
 * 这里用 koffi（预编译 FFI，无需编译）调 native，不引入 .node 编译产物以外的东西。
 * 万一 koffi 加载失败，退化为 return false，由调用方继续用 Electron 的 moveTop 兜底。
 */

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const HWND_TOPMOST = -1;

let setWindowPos = null;
let getAsyncKeyState = null;
let loadTried = false;

function load() {
  if ((setWindowPos && getAsyncKeyState) || loadTried) return;
  loadTried = true;
  try {
    // eslint-disable-next-line global-require
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    setWindowPos = user32.func(
      'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32_t uFlags)'
    );
    getAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)');
  } catch (err) {
    console.error('[topmost] koffi 不可用，退回 Electron 置顶：', err && err.message);
  }
}

function handleOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

/** 把窗口强制顶到所有置顶窗口之上（不抢焦点、不改尺寸位置） */
function forceTop(win) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  load();
  if (!setWindowPos) return false;
  try {
    return setWindowPos(handleOf(win), HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  } catch (err) {
    return false;
  }
}

/**
 * 鼠标左键当前是否按下。
 * 用轮询而不是 DOM click：Windows 上透明置顶窗口在“穿透 ↔ 接管”来回切之后，
 * Chromium 偶尔不再把点击派发给页面（实测），轮询按键状态更可靠。
 */
function isLeftButtonDown() {
  load();
  if (!getAsyncKeyState) return false;
  try {
    return (getAsyncKeyState(0x01) & 0x8000) !== 0;
  } catch (err) {
    return false;
  }
}

module.exports = { forceTop, handleOf, isLeftButtonDown };
