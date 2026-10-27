"""生成应用图标（512 PNG 给打包用，32/16 PNG 给托盘用）。

用法：python scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "assets"
BLUE_TOP = (86, 150, 255)
BLUE_BOTTOM = (38, 92, 214)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel(
            (0, y),
            (
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )
    return grad.resize((size, size))


def draw_icon(size: int) -> Image.Image:
    scale = size / 512
    bg = vertical_gradient(size, BLUE_TOP, BLUE_BOTTOM).convert("RGBA")
    bg.putalpha(rounded_mask(size, round(112 * scale)))

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 白色屏幕
    d.rounded_rectangle(
        (round(96 * scale), round(118 * scale), round(416 * scale), round(394 * scale)),
        radius=round(40 * scale),
        fill=(255, 255, 255, 255),
    )

    # 三条弹幕（白色屏幕里的蓝色滚动条）
    bars = [
        (140, 176, 330),
        (140, 244, 386),
        (140, 312, 268),
    ]
    for x1, y, x2 in bars:
        d.rounded_rectangle(
            (round(x1 * scale), round(y * scale), round(x2 * scale), round((y + 40) * scale)),
            radius=round(20 * scale),
            fill=(58, 116, 230, 255),
        )

    out = Image.alpha_composite(bg, layer)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icon = draw_icon(512)
    icon.save(OUT_DIR / "icon.png")

    for px in (32, 16):
        draw_icon(512).resize((px, px), Image.LANCZOS).save(OUT_DIR / f"tray-{px}.png")
    # Electron 托盘在 Windows 上优先用 32，文件名统一成 tray.png
    Image.open(OUT_DIR / "tray-32.png").save(OUT_DIR / "tray.png")

    # macOS 打包用不到，但留一份没坏处
    icon.resize((256, 256), Image.LANCZOS).save(OUT_DIR / "icon-256.png")
    print("icons written to", OUT_DIR)


if __name__ == "__main__":
    main()
