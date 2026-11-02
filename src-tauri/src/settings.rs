//! 设置项存储。
//!
//! 与旧版 `src/main/store.js` **逐键对齐**：同样的键名（camelCase）、同样的取值范围、
//! 同样的默认值、同样的落盘格式。这样讲师从旧版升级上来，`settings.json` 能直接沿用，
//! 字号/速度/WiFi 信息不用重填。
//!
//! 三条不变式（沿用旧版设计）：
//! 1. 白名单 SCHEMA：只允许已知键，非法值回落到默认值，绝不接受任意 JSON；
//! 2. **只存设置，永远不存任何一条观众消息**；
//! 3. 写盘 300ms 防抖，避免拖动滑块时疯狂写盘。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 与旧版 `store.js` 的 SCHEMA 一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 每人发送间隔（秒）
    pub interval_sec: u32,
    /// 弹幕字号
    pub font_px: u32,
    /// 滚动速度：每秒走过屏幕宽度的百分比
    pub speed: u32,
    /// 弹幕可用区域
    pub area: String,
    /// 不透明度
    pub opacity: u32,
    /// 投屏显示器（任意值，null 表示主屏）
    pub display_id: Option<Value>,
    /// 首选网卡地址
    pub preferred_ip: Option<String>,
    /// 界面主题
    pub theme: String,
    /// 现场 WiFi 名称（显示在投屏引导页）
    pub wifi_ssid: String,
    /// 现场 WiFi 密码
    pub wifi_password: String,
    /// 投影模式
    pub mode: String,
    /// 过滤强度
    pub filter_level: String,
    /// 自定义词表（换行分隔）
    pub custom_words: String,
    /// 高赞弹幕是否自动重新上屏
    pub auto_replay: bool,
}

pub const AREA_VALUES: [&str; 4] = ["full", "top", "middle", "bottom"];
pub const THEME_VALUES: [&str; 3] = ["system", "dark", "light"];
pub const MODE_VALUES: [&str; 2] = ["scroll", "cloud"];
pub const FILTER_LEVELS: [&str; 3] = ["off", "mark", "block"];

impl Default for Settings {
    fn default() -> Self {
        Self {
            interval_sec: 5,
            font_px: 38,
            speed: 8,
            area: "full".into(),
            opacity: 100,
            display_id: None,
            preferred_ip: None,
            theme: "system".into(),
            wifi_ssid: String::new(),
            wifi_password: String::new(),
            mode: "scroll".into(),
            filter_level: "block".into(),
            custom_words: String::new(),
            auto_replay: true,
        }
    }
}

fn clamp_u32(value: &Value, min: u32, max: u32, def: u32) -> u32 {
    match value.as_f64() {
        Some(n) if n.is_finite() => (n.round() as i64).clamp(min as i64, max as i64) as u32,
        _ => def,
    }
}

fn enum_of(value: &Value, allowed: &[&str], def: &str) -> String {
    match value.as_str() {
        Some(s) if allowed.contains(&s) => s.to_string(),
        _ => def.to_string(),
    }
}

/// 去控制字符后截断（与旧版 `String(value).replace(/[\u0000-\u001F\u007F]/g,'').trim().slice(0,max)` 对齐）
fn clean_string(value: &Value, max: usize) -> String {
    let raw = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => String::new(),
    };
    let filtered: String = raw.chars().filter(|c| !c.is_control()).collect();
    let trimmed = filtered.trim();
    trimmed.chars().take(max).collect()
}

impl Settings {
    /// 单键校验：键名不认识就忽略，值非法就回落默认值。
    pub fn apply_patch(&mut self, patch: &Value) -> bool {
        let Some(obj) = patch.as_object() else {
            return false;
        };
        let mut changed = false;
        let d = Settings::default();
        for (key, value) in obj {
            let before = serde_json::to_value(&*self).unwrap_or(Value::Null);
            match key.as_str() {
                "intervalSec" => self.interval_sec = clamp_u32(value, 1, 60, d.interval_sec),
                "fontPx" => self.font_px = clamp_u32(value, 20, 72, d.font_px),
                "speed" => self.speed = clamp_u32(value, 4, 30, d.speed),
                "area" => self.area = enum_of(value, &AREA_VALUES, &d.area),
                "opacity" => self.opacity = clamp_u32(value, 30, 100, d.opacity),
                "displayId" => self.display_id = if value.is_null() { None } else { Some(value.clone()) },
                "preferredIp" => {
                    self.preferred_ip = match value.as_str() {
                        Some(s) if !s.trim().is_empty() => Some(clean_string(value, 64)),
                        _ => None,
                    }
                }
                "theme" => self.theme = enum_of(value, &THEME_VALUES, &d.theme),
                "wifiSsid" => self.wifi_ssid = clean_string(value, 32),
                "wifiPassword" => self.wifi_password = clean_string(value, 64),
                "mode" => self.mode = enum_of(value, &MODE_VALUES, &d.mode),
                "filterLevel" => self.filter_level = enum_of(value, &FILTER_LEVELS, &d.filter_level),
                "customWords" => self.custom_words = clean_string(value, 6000),
                "autoReplay" => {
                    self.auto_replay = match value {
                        Value::Bool(b) => *b,
                        Value::String(s) if s == "true" => true,
                        Value::String(s) if s == "false" => false,
                        _ => d.auto_replay,
                    }
                }
                _ => continue, // 白名单之外的键直接丢弃
            }
            let after = serde_json::to_value(&*self).unwrap_or(Value::Null);
            if before != after {
                changed = true;
            }
        }
        changed
    }

    /// 从磁盘内容解析，逐键校验，坏值回落默认。
    fn from_json_lenient(raw: &str) -> Self {
        let mut out = Settings::default();
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw) {
            out.apply_patch(&Value::Object(obj));
        }
        out
    }
}

/* --------------------------------------------------------------- 数据目录 */

/// 便携模式（绿色版）：`portable.txt` 挨着 exe 且目录可写，就把配置写在 exe 旁边。
/// 解压到 Program Files 这类不可写目录时自动退回 `%APPDATA%\local-danmu`。
pub fn resolve_data_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));

    if let Some(dir) = &exe_dir {
        if dir.join("portable.txt").exists() && is_writable(dir) {
            return dir.clone();
        }
    }

    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("local-danmu");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".ldm-write-test");
    match fs::write(&probe, b"1") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/* ------------------------------------------------------------------- Store */

pub struct Store {
    path: PathBuf,
    inner: Mutex<Settings>,
    notify: Sender<()>,
}

impl Store {
    pub fn open(path: PathBuf) -> Arc<Store> {
        let data = fs::read_to_string(&path)
            .map(|raw| Settings::from_json_lenient(&raw))
            .unwrap_or_default();
        let (tx, rx) = mpsc::channel::<()>();
        let store = Arc::new(Store {
            path: path.clone(),
            inner: Mutex::new(data),
            notify: tx,
        });
        spawn_writer(path, rx, Arc::downgrade(&store));
        store
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// 合并一批设置，返回是否有变化。写盘走 300ms 防抖。
    pub fn set(&self, patch: &Value) -> bool {
        let changed = {
            let mut guard = match self.inner.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.apply_patch(patch)
        };
        if changed {
            let _ = self.notify.send(());
        }
        changed
    }

    pub fn as_json(&self) -> Value {
        serde_json::to_value(self.get()).unwrap_or(Value::Null)
    }
}

fn spawn_writer(path: PathBuf, rx: Receiver<()>, store: std::sync::Weak<Store>) {
    std::thread::Builder::new()
        .name("ldm-settings-writer".into())
        .spawn(move || loop {
            // 等到第一次变更；阻塞在这里，不占 CPU
            if rx.recv().is_err() {
                return;
            }
            // 防抖：300ms 内的连续变更合并成一次写盘
            loop {
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            let Some(store) = store.upgrade() else { return };
            let snapshot = store.get();
            let body = serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".into());
            if let Some(dir) = path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::write(&path, body);
            // 通道关闭且没有待写内容时退出
            match rx.try_recv() {
                Err(TryRecvError::Disconnected) => return,
                _ => continue,
            }
        })
        .ok();
}

/// 给前端用的「设置 + 默认值」快照，字段名与旧版 buildState().config 一致。
pub fn settings_to_json(s: &Settings) -> Value {
    json!({
        "intervalSec": s.interval_sec,
        "fontPx": s.font_px,
        "speed": s.speed,
        "area": s.area,
        "opacity": s.opacity,
        "displayId": s.display_id,
        "preferredIp": s.preferred_ip,
        "theme": s.theme,
        "wifiSsid": s.wifi_ssid,
        "wifiPassword": s.wifi_password,
        "mode": s.mode,
        "filterLevel": s.filter_level,
        "customWords": s.custom_words,
        "autoReplay": s.auto_replay,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_legacy_store() {
        let s = Settings::default();
        assert_eq!(s.interval_sec, 5);
        assert_eq!(s.font_px, 38);
        assert_eq!(s.speed, 8);
        assert_eq!(s.area, "full");
        assert_eq!(s.opacity, 100);
        assert_eq!(s.theme, "system");
        assert_eq!(s.mode, "scroll");
        assert_eq!(s.filter_level, "block");
        assert!(s.auto_replay);
    }

    #[test]
    fn clamps_and_rejects_out_of_range() {
        let mut s = Settings::default();
        s.apply_patch(&json!({ "intervalSec": 999 }));
        assert_eq!(s.interval_sec, 60, "上限");
        s.apply_patch(&json!({ "intervalSec": -5 }));
        assert_eq!(s.interval_sec, 1, "下限");
        s.apply_patch(&json!({ "speed": "abc" }));
        assert_eq!(s.speed, 8, "非数字回落默认值");
    }

    #[test]
    fn unknown_keys_are_dropped() {
        let mut s = Settings::default();
        let changed = s.apply_patch(&json!({ "evilKey": "x", "__proto__": 1 }));
        assert!(!changed);
        assert!(!serde_json::to_string(&s).unwrap().contains("evilKey"));
    }

    #[test]
    fn enums_fall_back() {
        let mut s = Settings::default();
        s.apply_patch(&json!({ "area": "diagonal", "theme": "neon" }));
        assert_eq!(s.area, "full");
        assert_eq!(s.theme, "system");
        s.apply_patch(&json!({ "area": "bottom", "theme": "light" }));
        assert_eq!(s.area, "bottom");
        assert_eq!(s.theme, "light");
    }

    #[test]
    fn strings_are_cleaned_and_capped() {
        let mut s = Settings::default();
        s.apply_patch(&json!({ "wifiSsid": "  教室WiFi\u{0000}\u{001f}  " }));
        assert_eq!(s.wifi_ssid, "教室WiFi");
        let long = "x".repeat(100);
        s.apply_patch(&json!({ "wifiPassword": long }));
        assert_eq!(s.wifi_password.chars().count(), 64);
    }

    #[test]
    fn legacy_settings_file_loads() {
        // 旧版 Electron 写出来的真实格式
        let raw = r#"{"intervalSec":8,"fontPx":44,"speed":12,"area":"top","opacity":80,
            "displayId":null,"preferredIp":"192.168.1.7","theme":"dark","wifiSsid":"培训WiFi",
            "wifiPassword":"pw123456","mode":"cloud","filterLevel":"mark",
            "customWords":"坏词1\n坏词2","autoReplay":false}"#;
        let s = Settings::from_json_lenient(raw);
        assert_eq!(s.interval_sec, 8);
        assert_eq!(s.font_px, 44);
        assert_eq!(s.speed, 12);
        assert_eq!(s.area, "top");
        assert_eq!(s.preferred_ip.as_deref(), Some("192.168.1.7"));
        assert_eq!(s.wifi_ssid, "培训WiFi");
        assert_eq!(s.mode, "cloud");
        assert_eq!(s.filter_level, "mark");
        assert!(!s.auto_replay);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let s = Settings::from_json_lenient("not json at all {{{");
        assert_eq!(s.interval_sec, 5);
    }
}
