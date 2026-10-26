"""Objective checks on a rendered screenshot of the game.

Usage: python tools/inspect_shot.py shots/game.png

Reports image size, how much of the canvas is the paper background, and
whether each signature palette colour actually appears. This is a stand-in for
looking at the picture: it proves the renderer drew a map rather than a blank
canvas, and that every visual channel (river, metro lines, stations, HUD) is
present.
"""
import sys
from collections import Counter

from PIL import Image

PALETTE = {
    "paper": (242, 239, 232),
    "letterbox": (232, 228, 218),
    "river": (199, 227, 242),
    "ink": (57, 57, 59),
    "white": (255, 255, 255),
    "red": (226, 86, 74),
    "blue": (61, 127, 208),
    "green": (74, 168, 92),
    "yellow": (239, 194, 46),
    "purple": (154, 99, 196),
    "orange": (240, 139, 60),
    "cyan": (49, 179, 189),
    "special_fill": (255, 244, 220),
}

TOLERANCE = 6

# A given run only uses as many line colours as the player has unlocked, so
# these are informational rather than required.
OPTIONAL = {"letterbox", "purple", "orange", "cyan"}


def near(a, b, tol=TOLERANCE):
    return all(abs(x - y) <= tol for x, y in zip(a[:3], b[:3]))


def main(path):
    image = Image.open(path).convert("RGB")
    pixels = list(image.getdata())
    total = len(pixels)
    counts = Counter(pixels)

    print(f"file        : {path}")
    print(f"size        : {image.width} x {image.height} ({total} px)")
    print(f"unique      : {len(counts)}")

    # Dominant colours, ignoring the antialiasing haze.
    print("top colours :")
    for colour, count in counts.most_common(8):
        print(f"   {colour}  {count * 100.0 / total:5.2f}%")

    print("palette hits:")
    missing = []
    for name, colour in PALETTE.items():
        exact = counts.get(colour, 0)
        close = exact if exact else sum(c for p, c in counts.items() if near(p, colour))
        pct = close * 100.0 / total
        flag = "ok " if pct >= 0.01 else "-- "
        if pct < 0.01 and name not in OPTIONAL:
            missing.append(name)
        print(f"   {flag}{name:12s} {close:8d} px  {pct:6.3f}%")

    paper_pct = sum(c for p, c in counts.items() if near(p, PALETTE["paper"])) * 100.0 / total
    blank = len(counts) < 50
    print(f"paper share : {paper_pct:.1f}%")
    print(f"verdict     : {'BLANK/FAILED' if blank and paper_pct > 95 else 'rendered'}")

    if missing:
        print(f"unexpected missing colours: {', '.join(missing)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "shots/game.png"))
