'use strict';

/**
 * 极简配置存储：只保存设置项（限流间隔、字号、速度…），
 * 绝不保存任何一条观众消息。写盘做了 300ms 防抖。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA = {
  intervalSec: { type: 'number', min: 1, max: 60, def: 5 },
  fontPx: { type: 'number', min: 20, max: 72, def: 38 },
  // 滚动速度 = 每秒钟走过屏幕宽度的百分之几。旧版 speedPct 默认 25 太快，换键名重新起算
  speed: { type: 'number', min: 4, max: 30, def: 8 },
  area: { type: 'enum', values: ['full', 'top', 'middle', 'bottom'], def: 'full' },
  opacity: { type: 'number', min: 30, max: 100, def: 100 },
  displayId: { type: 'any', def: null },
  preferredIp: { type: 'any', def: null },
  theme: { type: 'enum', values: ['system', 'dark', 'light'], def: 'system' },
  wifiSsid: { type: 'string', max: 32, def: '' },
  wifiPassword: { type: 'string', max: 64, def: '' },
  mode: { type: 'enum', values: ['scroll', 'cloud'], def: 'scroll' },
  filterLevel: { type: 'enum', values: ['off', 'mark', 'block'], def: 'block' },
  customWords: { type: 'string', max: 6000, def: '' }
};

function sanitize(key, value) {
  const rule = SCHEMA[key];
  if (!rule) return undefined;
  if (rule.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return rule.def;
    return Math.min(rule.max, Math.max(rule.min, Math.round(n)));
  }
  if (rule.type === 'enum') {
    return rule.values.includes(value) ? value : rule.def;
  }
  if (rule.type === 'string') {
    const s = String(value == null ? '' : value)
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim();
    return s.slice(0, rule.max || 120);
  }
  return value == null ? rule.def : value;
}

function defaults() {
  const out = {};
  for (const [k, rule] of Object.entries(SCHEMA)) out[k] = rule.def;
  return out;
}

function createStore(file) {
  let data = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(SCHEMA)) {
        if (key in raw) data[key] = sanitize(key, raw[key]);
      }
    }
  } catch (_) {
    /* 首次运行或文件损坏，用默认值 */
  }

  let timer = null;
  function persist() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      } catch (err) {
        console.error('[store] 写入配置失败:', err.message);
      }
    }, 300);
    if (timer.unref) timer.unref();
  }

  return {
    path: file,
    get() {
      return data;
    },
    set(patch) {
      let changed = false;
      for (const [key, value] of Object.entries(patch || {})) {
        if (!(key in SCHEMA)) continue;
        const next = sanitize(key, value);
        if (data[key] !== next) {
          data[key] = next;
          changed = true;
        }
      }
      if (changed) persist();
      return data;
    }
  };
}

module.exports = { createStore, SCHEMA, defaults };
