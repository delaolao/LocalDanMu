"""生成应用图标：以项目根目录的 LocalDanMu-512x512.png 为母版，输出打包和托盘用的各尺寸。

用法：python scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "LocalDanMu-512x512.png"
OUT_DIR = ROOT / "assets"


def load_source() -> Image.Image:
    if not SOURCE.exists():
        raise SystemExit(f"缺少母版图片：{SOURCE}")
    icon = Image.open(SOURCE).convert("RGBA")
    if icon.size != (512, 512):
        icon = icon.resize((512, 512), Image.LANCZOS)
    return icon


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = load_source()

    master.save(OUT_DIR / "icon.png")
    master.resize((256, 256), Image.LANCZOS).save(OUT_DIR / "icon-256.png")

    for px in (32, 16):
        master.resize((px, px), Image.LANCZOS).save(OUT_DIR / f"tray-{px}.png")
    # Electron 托盘在 Windows 上优先用 32，文件名统一成 tray.png
    Image.open(OUT_DIR / "tray-32.png").save(OUT_DIR / "tray.png")

    print("icons written to", OUT_DIR)


if __name__ == "__main__":
    main()
