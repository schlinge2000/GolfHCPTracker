#!/usr/bin/env python3
"""Erzeugt public/og-image.jpg – die Vorschaukarte fuer Slack, WhatsApp und Co.

Aufbau: links ein Textfeld auf dem Markengruen, rechts die Aufmacher-Illustration
aus public/hero-fairway.jpg. Damit zeigt die Vorschau dasselbe Motiv wie die
Startseite und traegt denselben Claim.

    python3 scripts/generate-og-image.py

Braucht Pillow (pip install pillow). Schrift: DejaVu Sans, weil die Hausschrift
Aptos hier nicht vorliegt – im Bild faellt der Unterschied nicht auf.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
HERO = ROOT / "public" / "hero-fairway.jpg"
ICON = ROOT / "public" / "pwa-512.png"
OUT = ROOT / "public" / "og-image.jpg"

WIDTH, HEIGHT = 1200, 630
IMAGE_WIDTH = 470          # Breite der Illustration am rechten Rand
FADE_WIDTH = 150           # so weit laeuft ihr linker Rand ins Gruen aus

HEADLINE = ["Fordere deinen", "Flight heraus."]
SUBLINE = "Erzeuge Drucksituationen im Training. Denn unter Druck lernst du mehr als auf der Range."
PAD = 64

DARK = (10, 42, 33)
MID = (18, 82, 62)
ACCENT = (77, 216, 164)
WHITE = (255, 255, 255)
MUTED = (188, 219, 205)

FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
BOLD = FONT_DIR / "DejaVuSans-Bold.ttf"
REGULAR = FONT_DIR / "DejaVuSans.ttf"


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def gradient(size, top, bottom):
    """Senkrechter Verlauf – ein Pixel breit gezeichnet und dann gestreckt."""
    width, height = size
    strip = Image.new("RGB", (1, height))
    for y in range(height):
        ratio = y / max(1, height - 1)
        strip.putpixel((0, y), tuple(
            round(top[channel] + (bottom[channel] - top[channel]) * ratio) for channel in range(3)
        ))
    return strip.resize((width, height))


def wrap(draw, text: str, font_obj, max_width: int) -> list[str]:
    """Bricht Text am Wortende, gemessen an der echten Textbreite."""
    lines: list[str] = []
    words = text.split()
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=font_obj) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def cover(image: Image.Image, box) -> Image.Image:
    """Wie CSS object-fit: cover – fuellt die Box und beschneidet den Ueberhang."""
    width, height = box
    scale = max(width / image.width, height / image.height)
    scaled = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    # Etwas unterhalb der Mitte anschneiden, wie objectPosition "center 56%".
    left = (scaled.width - width) // 2
    top = round((scaled.height - height) * 0.56)
    return scaled.crop((left, top, left + width, top + height))


def main() -> None:
    canvas = gradient((WIDTH, HEIGHT), DARK, MID)

    hero = Image.open(HERO).convert("RGB")
    panel = cover(hero, (IMAGE_WIDTH, HEIGHT))

    # Der linke Rand der Illustration laeuft ins Markengruen aus: die Maske steigt
    # ueber FADE_WIDTH von 0 auf 255, dahinter bleibt das Bild voll deckend.
    panel_mask = Image.new("L", (IMAGE_WIDTH, HEIGHT), 255)
    for x in range(FADE_WIDTH):
        value = round(255 * (x / (FADE_WIDTH - 1)) ** 1.6)
        panel_mask.paste(value, (x, 0, x + 1, HEIGHT))
    canvas.paste(panel, (WIDTH - IMAGE_WIDTH, 0), panel_mask)

    draw = ImageDraw.Draw(canvas)

    # Eyebrow
    draw.text((PAD, 92), "THE WOLF GOLF CLUB", font=font(BOLD, 22), fill=MUTED)

    # Schlagzeile, von Hand umbrochen – zwei Zeilen sitzen im Textfeld
    headline = font(BOLD, 62)
    for index, line in enumerate(HEADLINE):
        draw.text((PAD, 140 + index * 72), line, font=headline, fill=WHITE)

    # Unterzeile – umgebrochen auf die Breite des Textfelds
    sub = font(REGULAR, 27)
    text_width = WIDTH - IMAGE_WIDTH - 2 * PAD + 40
    y = 302
    for line in wrap(draw, SUBLINE, sub, text_width):
        draw.text((PAD, y), line, font=sub, fill=MUTED)
        y += 38

    # Merkmale als Pillen, direkt unter der Unterzeile
    chip_font = font(BOLD, 21)
    x = PAD
    chip_top = y + 20
    for label in ["Fünf Spielformate", "Per QR-Code", "Kostenlos"]:
        label_width = draw.textlength(label, font=chip_font)
        box = (x, chip_top, x + label_width + 36, chip_top + 46)
        draw.rounded_rectangle(box, radius=23, fill=(23, 96, 73))
        draw.text((x + 18, chip_top + 11), label, font=chip_font, fill=(214, 240, 228))
        x = box[2] + 12

    # Fusszeile: Bildmarke, Name, Domain
    icon = Image.open(ICON).convert("RGBA").resize((72, 72), Image.LANCZOS)
    canvas.paste(icon, (PAD, HEIGHT - 72 - PAD), icon)
    draw.text((PAD + 92, HEIGHT - 72 - PAD + 6), "The Wolf Golf Club", font=font(BOLD, 30), fill=WHITE)
    draw.text((PAD + 92, HEIGHT - 72 - PAD + 44), "www.wolfgolf.club", font=font(REGULAR, 22), fill=MUTED)

    canvas.save(OUT, "JPEG", quality=86, optimize=True, progressive=True)
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} KB, {WIDTH}x{HEIGHT}")


if __name__ == "__main__":
    main()
