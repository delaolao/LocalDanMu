//! 二维码生成：本地生成 PNG data URL，不联网。
//!
//! 旧版用 npm 的 `qrcode` 生成 720×720 的 data URL 交给界面显示。这里用纯 Rust 的
//! `qrcode` crate 拿到模块矩阵，自己按整数倍放大并补静区，再用 `png` 编码——
//! 之所以不直接用 `qrcode` 的 image 特性：那会拖进整套 `image` 编解码器，
//! 而我们只需要一张 1 位深的灰度图，体积差距是几百 KB 级别的。

use base64::Engine;
use qrcode::types::Color as QrColor;
use qrcode::QrCode;

/// 静区宽度（模块数）。规范建议 4，低于这个值扫码率会掉。
const QUIET_ZONE: usize = 4;
/// 目标边长范围（像素）。太小的高清屏会糊，太大的 data URL 又没必要。
const MIN_SIDE: usize = 480;
const MAX_SIDE: usize = 720;

/// 生成 `data:image/png;base64,...`。失败返回 None（调用方显示占位即可，绝不 panic）。
pub fn data_url(text: &str) -> Option<String> {
    let png_bytes = png_bytes(text)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 生成 PNG 字节。抽出来单独可测。
pub fn png_bytes(text: &str) -> Option<Vec<u8>> {
    let code = QrCode::new(text.as_bytes()).ok()?;
    let modules = code.width();
    let total_modules = modules + QUIET_ZONE * 2;

    // 整数倍放大：避免每模块边缘出现半透明/灰边，扫码更稳
    let mut scale = MAX_SIDE / total_modules;
    if scale == 0 {
        scale = 1;
    }
    if total_modules * scale < MIN_SIDE {
        scale = MIN_SIDE.div_ceil(total_modules).max(1);
    }
    let side = total_modules * scale;

    let colors = code.to_colors();
    let mut pixels = vec![255u8; side * side];

    for (i, color) in colors.iter().enumerate() {
        if *color != QrColor::Dark {
            continue;
        }
        let mx = i % modules;
        let my = i / modules;
        let x0 = (mx + QUIET_ZONE) * scale;
        let y0 = (my + QUIET_ZONE) * scale;
        for dy in 0..scale {
            let row = (y0 + dy) * side;
            for dx in 0..scale {
                pixels[row + x0 + dx] = 0;
            }
        }
    }

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, side as u32, side as u32);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&pixels).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_valid_png_data_url() {
        let url = data_url("http://192.168.1.5:8080/j/abcd2345").expect("应当能生成二维码");
        assert!(url.starts_with("data:image/png;base64,"));

        let b64 = url.trim_start_matches("data:image/png;base64,");
        let raw = base64::engine::general_purpose::STANDARD.decode(b64).expect("base64 应当可解");
        assert_eq!(&raw[..8], b"\x89PNG\r\n\x1a\n", "必须是合法 PNG 头");
    }

    #[test]
    fn side_length_is_within_target_range() {
        let raw = png_bytes("http://192.168.1.5:8080/j/abcd2345").unwrap();
        // 从 IHDR 直接读宽高（偏移 16..24）
        let w = u32::from_be_bytes([raw[16], raw[17], raw[18], raw[19]]);
        let h = u32::from_be_bytes([raw[20], raw[21], raw[22], raw[23]]);
        assert_eq!(w, h, "必须正方形");
        assert!(w as usize >= MIN_SIDE, "太小会糊：{w}");
        assert!(w as usize <= MAX_SIDE, "太大没必要：{w}");
    }

    #[test]
    fn handles_long_url_without_panicking() {
        let long = format!("http://192.168.100.200:8099/j/{}", "a".repeat(60));
        assert!(data_url(&long).is_some());
    }
}
