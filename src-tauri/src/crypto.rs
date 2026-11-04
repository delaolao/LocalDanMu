//! 远程模式的端到端加密。
//!
//! 目标：手机 ←→ 讲师机 之间的消息内容对 Cloudflare 不可见。
//!
//! 做法：
//! - 隧道开启时生成 32 字节随机密钥，拼进二维码的 `#k=`（URL fragment 不会发给服务器）
//! - 只有来自**回环地址**的连接（即 cloudflared 转发进来的）才走加密信封
//! - 局域网连接保持明文，零开销、零改动
//!
//! 信封格式：`{"type":"enc","iv":"<12字节 base64>","data":"<AES-256-GCM 密文 base64>"}`

use std::sync::{Arc, RwLock};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

pub type RemoteKey = Arc<RwLock<Option<[u8; 32]>>>;

pub fn new_slot() -> RemoteKey {
    Arc::new(RwLock::new(None))
}

pub fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    if getrandom::fill(&mut key).is_err() {
        // 极端情况下退回时间戳混合，保证不 panic
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in key.iter_mut().enumerate() {
            *b = ((now >> ((i % 16) * 8)) & 0xff) as u8 ^ (i as u8);
        }
    }
    key
}

pub fn set_key(slot: &RemoteKey, key: Option<[u8; 32]>) {
    if let Ok(mut g) = slot.write() {
        *g = key;
    }
}

pub fn get_key(slot: &RemoteKey) -> Option<[u8; 32]> {
    slot.read().ok().and_then(|g| *g)
}

/// 把一段明文包成加密信封。失败返回 None（调用方应回退成明文，绝不丢消息）。
pub fn wrap(key: &[u8; 32], plain: &str) -> Option<String> {
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let mut iv = [0u8; 12];
    if getrandom::fill(&mut iv).is_err() {
        return None;
    }
    let sealed = cipher
        .encrypt(Nonce::from_slice(&iv), plain.as_bytes())
        .ok()?;
    Some(
        serde_json::json!({
            "type": "enc",
            "iv": B64.encode(iv),
            "data": B64.encode(sealed),
        })
        .to_string(),
    )
}

/// 拆信封。失败返回 None（调用方应当拒绝这条消息）。
pub fn unwrap(key: &[u8; 32], envelope: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(envelope).ok()?;
    if value.get("type")?.as_str()? != "enc" {
        return None;
    }
    let iv = B64.decode(value.get("iv")?.as_str()?).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let data = B64.decode(value.get("data")?.as_str()?).ok()?;
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), data.as_slice())
        .ok()?;
    String::from_utf8(plain).ok()
}

/// URL fragment 用的 base64url（无填充）
pub fn key_to_fragment(key: &[u8; 32]) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let key = random_key();
        let secret = r#"{"type":"message","payload":"今天天气不错"}"#;
        let env = wrap(&key, secret).expect("应当能加密");
        let parsed: serde_json::Value = serde_json::from_str(&env).expect("信封必须是合法 JSON");
        assert_eq!(parsed["type"], "enc", "信封必须标明 enc");
        assert!(!env.contains("天气"), "密文里不能出现明文");
        assert_eq!(unwrap(&key, &env).as_deref(), Some(secret));
    }

    #[test]
    fn wrong_key_fails() {
        let a = random_key();
        let b = random_key();
        let env = wrap(&a, "hello").unwrap();
        assert!(unwrap(&b, &env).is_none(), "换密钥必须解不开");
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = random_key();
        let env = wrap(&key, "hello").unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&env).unwrap();
        let data = v["data"].as_str().unwrap().to_string();
        // 改掉一个字符
        let mut bytes = data.into_bytes();
        bytes[0] = if bytes[0] == b'A' { b'B' } else { b'A' };
        v["data"] = serde_json::Value::String(String::from_utf8(bytes).unwrap());
        assert!(
            unwrap(&key, &v.to_string()).is_none(),
            "改过的密文必须校验失败"
        );
    }

    #[test]
    fn fragment_is_url_safe() {
        let key = random_key();
        let frag = key_to_fragment(&key);
        assert!(!frag.contains('+') && !frag.contains('/') && !frag.contains('='));
    }
}
