import { describe, expect, it } from "vitest";

import { buildShareUrl, describeShareCard, parseShareHash, type CourseCard, type PlayerCard } from "./shareCard";

const ORIGIN = "https://wolfgolf.club";

const hashOf = (url: string) => url.slice(url.indexOf("#"));

const holes18 = Array.from({ length: 18 }, (_, index) => ({
  par: [4, 5, 3, 4, 4, 4, 3, 5, 4][index % 9],
  si: index + 1,
}));

describe("Spielerkarte", () => {
  const card: PlayerCard = { kind: "player", name: "Ben Mustermann", hcpIndex: 20.4 };

  it("übersteht den Weg durch den Link", () => {
    const parsed = parseShareHash(hashOf(buildShareUrl(card, ORIGIN)));
    expect(parsed).toEqual(card);
  });

  it("legt die Nutzlast ins Fragment, damit sie den Server nie erreicht", () => {
    const url = buildShareUrl(card, ORIGIN);
    expect(url.startsWith("https://wolfgolf.club/#p=")).toBe(true);
    expect(url.slice(0, url.indexOf("#"))).toBe("https://wolfgolf.club/");
  });

  it("rundet den Index auf eine Nachkommastelle", () => {
    const parsed = parseShareHash(hashOf(buildShareUrl({ ...card, hcpIndex: 20.44 }, ORIGIN)));
    expect(parsed).toMatchObject({ hcpIndex: 20.4 });
  });

  it("nimmt Scratch- und Plus-Handicaps an", () => {
    for (const hcpIndex of [0, -1.5, 54]) {
      const parsed = parseShareHash(hashOf(buildShareUrl({ ...card, hcpIndex }, ORIGIN)));
      expect(parsed).toMatchObject({ hcpIndex });
    }
  });

  it("überlebt Umlaute im Namen", () => {
    const parsed = parseShareHash(hashOf(buildShareUrl({ ...card, name: "Jürgen Groß" }, ORIGIN)));
    expect(parsed).toMatchObject({ name: "Jürgen Groß" });
  });
});

describe("Platzkarte", () => {
  const card: CourseCard = {
    kind: "course",
    name: "GC Haus Kambach",
    courseRating: 71.2,
    slopeRating: 128,
    par: 72,
    tee: "Gelb",
    holeCount: 18,
    holeData: holes18,
  };

  it("überträgt die Scorekarte mit Par und Stroke Index je Loch", () => {
    const parsed = parseShareHash(hashOf(buildShareUrl(card, ORIGIN)));
    expect(parsed).toEqual(card);
  });

  it("kommt auch ohne hinterlegte Scorekarte aus", () => {
    const { holeData, holeCount, ...ohneKarte } = card;
    const parsed = parseShareHash(hashOf(buildShareUrl(ohneKarte as CourseCard, ORIGIN)));
    expect(parsed).toEqual(ohneKarte);
  });

  it("bleibt klein genug für einen scanbaren QR-Code", () => {
    // 18 Loch mit Scorekarte: deutlich unter dem, was ein QR-Code fasst.
    expect(buildShareUrl(card, ORIGIN).length).toBeLessThan(400);
  });

  it("packt Stroke Index über 9 als Base36", () => {
    const url = buildShareUrl(card, ORIGIN);
    const parsed = parseShareHash(hashOf(url)) as CourseCard;
    expect(parsed.holeData?.map(hole => hole.si)).toEqual(holes18.map(hole => hole.si));
  });
});

describe("kaputte oder fremde Links", () => {
  it("gibt null zurück statt zu werfen", () => {
    const cases = [
      "",
      "#",
      "#irgendwas",
      "#p=",
      "#p=nicht-base64!!",
      "#p=" + btoa("kein json"),
      "#x=" + btoa(JSON.stringify({ v: 1, n: "Ben", i: 12 })),
    ];
    for (const hash of cases) expect(parseShareHash(hash)).toBeNull();
  });

  it("weist eine andere Formatversion ab", () => {
    const encoded = btoa(JSON.stringify({ v: 99, n: "Ben", i: 12 })).replace(/=+$/, "");
    expect(parseShareHash(`#p=${encoded}`)).toBeNull();
  });

  it("weist unplausible Werte ab", () => {
    const encode = (payload: unknown) => btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(parseShareHash(`#p=${encode({ v: 1, n: "Ben", i: 99 })}`)).toBeNull();
    expect(parseShareHash(`#p=${encode({ v: 1, n: "", i: 12 })}`)).toBeNull();
    expect(parseShareHash(`#c=${encode({ v: 1, n: "GC", cr: 71, sr: 400, par: 72 })}`)).toBeNull();
    expect(parseShareHash(`#c=${encode({ v: 1, n: "GC", cr: 71, par: 72 })}`)).toBeNull();
  });

  it("kürzt übermäßig lange Namen, statt sie zu übernehmen", () => {
    const long = "x".repeat(500);
    const parsed = parseShareHash(hashOf(buildShareUrl({ kind: "player", name: long, hcpIndex: 12 }, ORIGIN)));
    expect((parsed as PlayerCard).name.length).toBe(60);
  });
});

describe("describeShareCard", () => {
  it("beschreibt Spieler und Platz für den Übernehmen-Dialog", () => {
    expect(describeShareCard({ kind: "player", name: "Ben", hcpIndex: 20.4 })).toBe("Ben · HCP-Index 20,4");
    expect(describeShareCard({ kind: "course", name: "GC Test", courseRating: 71.2, slopeRating: 128, par: 72, tee: "Gelb", holeData: holes18 }))
      .toBe("GC Test · CR 71.2 · SR 128 · Par 72 · Gelb · mit Scorekarte");
  });
});
