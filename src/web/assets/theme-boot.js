'use strict';

/**
 * 在 <head> 里同步执行：先把主题定下来再渲染，避免浅色用户看到一瞬间的黑屏。
 * 只认 dark / light；system 交给 CSS 的 prefers-color-scheme。
 */
(function () {
  try {
    var saved = localStorage.getItem('dm_theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {
    /* 无痕模式下忽略 */
  }
})();
