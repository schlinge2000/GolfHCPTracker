# Aufmacher-Bild: Prompt für die Bildgenerierung

Die Startseite zeigt im Aufmacher `public/hero-fairway.jpg` (Komponente `HeroArt` in
`golf_hcp_tracker.tsx`). Die Datei muss vorhanden sein – einen gezeichneten Ersatz gibt
es nicht mehr. Ein neues Motiv ist eingesetzt, indem die Datei ersetzt wird; danach
`python3 scripts/generate-og-image.py` laufen lassen, damit die Vorschaukarte dasselbe
Motiv zeigt.

## Anforderungen an die Datei

- **Pfad:** `public/hero-fairway.jpg`
- **Format:** hochkant, 4:5 oder 3:4, mindestens 1200 × 1500 px
- **Beschnitt:** Das Bild füllt die ganze Höhe der Aufmacher-Karte und wird dabei an
  den Rändern beschnitten (`object-fit: cover`). Alles Wichtige gehört in die Mitte,
  am oberen und unteren Rand ruhig Luft lassen.
- **Kein Text im Bild.** Schlagzeile und Marke stehen daneben im HTML.

## Prompt (englisch)

> Flat vector poster illustration, portrait 4:5. One-point perspective looking up a
> long golf fairway from the tee towards an elevated green with a flagstick at the far
> end. A lean grey wolf sprints up the centre of the fairway, well ahead and closest to
> the green, tail streaming behind it. Three golfers with carry bags on their backs
> chase after it, staggered in depth: the nearest one large in the lower third, the
> farthest small near the middle. Three or four dotted white ball-flight arcs curve up
> the fairway and converge on the flag, each ending in a small white ball. Mown stripes
> on the fairway lead the eye to the green, dark rough and a low treeline on both sides,
> two pale sand bunkers at the edges, long soft shadows.
>
> Style: bold flat silhouettes, minimal detail, no outlines, generous negative space,
> dusk light. Limited palette of deep emerald and mint greens (#062A22, #0A3A2C,
> #12654E, #1D9E75, #2FB184, #38C692, #4CD8A4) with pale sand (#E8DCB8) and white
> accents. Sporty and playful, a chase in good humour.
>
> Negative: no text, no letters, no numbers, no logos, no watermark, no photorealism,
> no 3D render, no aggressive or snarling wolf, no blood, no detailed faces, no crowds,
> no buildings, no carts, no busy background.

## Prompt (deutsch, falls das Werkzeug es braucht)

> Flache Vektor-Illustration im Posterstil, Hochformat 4:5. Zentralperspektive: Blick
> vom Abschlag einen langen Fairway hinauf zu einem erhöhten Grün mit Fahne. Ein
> schlanker grauer Wolf sprintet mittig den Fairway hinauf, deutlich voran und am
> nächsten am Grün, die Rute im Wind. Drei Golfer mit Bag auf dem Rücken jagen ihm
> nach, in der Tiefe gestaffelt: der vorderste groß im unteren Drittel, der hinterste
> klein zur Bildmitte. Drei bis vier gepunktete weiße Ball-Flugbahnen schwingen den
> Fairway hinauf und laufen an der Fahne zusammen, jede endet in einem kleinen weißen
> Ball. Mähstreifen führen den Blick zum Grün, dunkles Rough und eine niedrige
> Baumreihe an beiden Seiten, zwei helle Bunker am Rand, lange weiche Schatten.
>
> Stil: kräftige flache Silhouetten, wenig Detail, keine Konturlinien, viel Ruhe im
> Bild, Dämmerungslicht. Begrenzte Palette aus tiefen Smaragd- und Minttönen (#062A22,
> #0A3A2C, #12654E, #1D9E75, #2FB184, #38C692, #4CD8A4), dazu helles Sandbeige
> (#E8DCB8) und Weiß. Sportlich und mit Humor – eine Jagd, keine Bedrohung.
>
> Negativ: kein Text, keine Buchstaben, keine Zahlen, keine Logos, kein Wasserzeichen,
> kein Fotorealismus, kein 3D-Render, kein aggressiver oder fletschender Wolf, kein
> Blut, keine ausgearbeiteten Gesichter, keine Menschenmengen, keine Gebäude, keine
> Carts, kein unruhiger Hintergrund.

## Wenn das Bild da ist

1. Datei als `public/hero-fairway.jpg` ablegen.
2. `python3 scripts/generate-og-image.py` – baut `public/og-image.jpg` (1200 × 630) aus
   demselben Motiv plus Claim und Bildmarke. Braucht Pillow.
3. Beschnitt prüfen: Am Telefon steht das Bild im Verhältnis 4:5, am Desktop füllt es die
   ganze Höhe der Aufmacher-Karte. Sitzt der Ausschnitt falsch, `objectPosition` in
   `HeroArt` anpassen statt das Bild zu ändern (aktuell `center 56%`).
