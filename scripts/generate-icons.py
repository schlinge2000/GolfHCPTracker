#!/usr/bin/env python3
"""Erzeugt alle Wolf-Golf-Icons aus einer einzigen Vektorquelle.

Die Bildmarke ist die Golf-Fahne mit dem Wolfskopf: gruene Kachel, weisse
Fahnenstange, weisse Fahne mit dunkelgruenem Wolfskopf im Profil, Golfball
auf der Puttlinie.

Aufruf:
    pip install cairosvg
    python3 scripts/generate-icons.py

Schreibt nach public/:
    logo.svg            volle Bildmarke (Doku, grosse Darstellung)
    favicon.svg         kompakte Variante ohne Ball/Puttlinie fuer Tabs
    icon-maskable.svg   randlos, Inhalt in der Android-Safe-Zone
    favicon-16/32.png, apple-touch-icon.png, pwa-192/512.png,
    pwa-maskable-512.png

Die Geometrie ist bewusst in der React-Komponente `BrandMark`
(golf_hcp_tracker.tsx) gespiegelt - Aenderungen hier bitte dort nachziehen.
"""

import os

import cairosvg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")

GREEN_LIGHT = "#25AF83"
GREEN = "#1D9E75"
GREEN_DARK = "#0F5C46"
WOLF = "#0E4C3A"

# Wolfskopf im Profil, entworfen in einer 0..91 x 0..71 Box (Blick nach links).
WOLF_HEAD = (
    "M 2 37 L 30 33 L 36 27 L 46 24 L 58 0 L 69 23 L 80 32 L 91 45 "
    "L 75 50 L 84 60 L 66 62 L 69 71 L 50 66 L 41 62 L 28 51 "
    "L 12 47 L 5 45.5 L 0 41 Z"
)
WOLF_EYE = "M 33 30.5 L 41.5 33 L 38 37 L 32 34.5 Z"
WOLF_EAR = "M 53 9 L 63 21 L 55 21 Z"

# Fahne mit Schwalbenschwanz, leicht im Wind (64x64 Koordinatensystem).
FLAG = (
    "M 17.5 8.5 C 30 6.5 39.5 10 50.5 9.5 L 44.5 21.5 L 50.5 33.5 "
    "C 39.5 33 30 36.5 17.5 34.5 Z"
)

# Wolfskopf in die Fahne einpassen: Zielbox 23.2 x 18.1 um (31.5, 21.8).
HEAD_SCALE = 0.255
HEAD_TX = 31.5 - 45.5 * HEAD_SCALE
HEAD_TY = 21.8 - 35.5 * HEAD_SCALE

WOLF_FLAG = f"""    <path d="{FLAG}" fill="#fff"/>
    <g transform="translate({HEAD_TX:.3f} {HEAD_TY:.3f}) scale({HEAD_SCALE})">
      <path d="{WOLF_HEAD}" fill="{WOLF}"/>
      <path d="{WOLF_EYE}" fill="#fff"/>
      <path d="{WOLF_EAR}" fill="#fff"/>
    </g>"""

# Volle Bildmarke: Fahne am Pin, Ball auf der Puttlinie.
MARK_FULL = f"""  <g>
    <line x1="10" y1="54.5" x2="54" y2="54.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.32"/>
    <line x1="15.5" y1="8.5" x2="15.5" y2="54.5" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <circle cx="26" cy="51.2" r="3.3" fill="#fff"/>
{WOLF_FLAG}
  </g>"""

# Kompakte Bildmarke fuer 16-40 px: ohne Ball und Puttlinie, Fahne 1.34x
# vergroessert, damit der Wolfskopf auch im Tab noch erkennbar bleibt.
MARK_COMPACT = f"""  <g transform="translate(-11.26 -0.71) scale(1.34)">
    <line x1="15.5" y1="8.5" x2="15.5" y2="42.3" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
{WOLF_FLAG}
  </g>"""


def build(mark: str, radius: float, content_scale: float = 1.0) -> str:
    """Baut das Logo als SVG. `content_scale` schrumpft die Bildmarke fuer
    maskable- bzw. Apple-Icons in die jeweilige Safe-Zone."""
    if content_scale != 1.0:
        mark = (f'  <g transform="translate(32 32) scale({content_scale}) translate(-32 -32)">\n'
                f"{mark}\n  </g>")
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Wolf Golf">
  <title>Wolf Golf</title>
  <defs>
    <linearGradient id="wolfGolfBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{GREEN_LIGHT}"/>
      <stop offset="0.5" stop-color="{GREEN}"/>
      <stop offset="1" stop-color="{GREEN_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="{radius}" fill="url(#wolfGolfBg)"/>
{mark}
</svg>
"""


def write(path: str, data: str) -> None:
    with open(os.path.join(PUBLIC, path), "w", encoding="utf-8") as handle:
        handle.write(data)
    print("wrote", path)


def png(source: str, path: str, size: int) -> None:
    cairosvg.svg2png(bytestring=source.encode(), output_width=size, output_height=size,
                     write_to=os.path.join(PUBLIC, path))
    print("wrote", path, f"({size}px)")


def main() -> None:
    logo = build(MARK_FULL, 13)
    compact = build(MARK_COMPACT, 13)
    maskable = build(MARK_FULL, 0, 0.76)
    apple = build(MARK_FULL, 0, 0.88)

    write("logo.svg", logo)
    write("favicon.svg", compact)
    write("icon-maskable.svg", maskable)

    png(compact, "favicon-16.png", 16)
    png(compact, "favicon-32.png", 32)
    png(logo, "pwa-192.png", 192)
    png(logo, "pwa-512.png", 512)
    png(apple, "apple-touch-icon.png", 180)
    png(maskable, "pwa-maskable-512.png", 512)


if __name__ == "__main__":
    main()
