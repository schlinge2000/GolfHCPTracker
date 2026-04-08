import { describe, expect, it } from "vitest";

import { calcRawScoreDiff, calcScoreDiff } from "./hcpMath";

const pdfSampleRounds = [
  {
    label: "Pulheim 03.04.2026",
    hi: 48.4,
    holes: 9,
    gross: 48,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 46.6,
  },
  {
    label: "Pulheim 29.03.2026",
    hi: 53.4,
    holes: 9,
    gross: 49,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 50.4,
  },
  {
    label: "Kambach 11.10.2025",
    hi: 54.0,
    holes: 9,
    gross: 67,
    courseRating: 36,
    slopeRating: 134,
    reportedDiff: 55.4,
  },
  {
    label: "Kambach 30.08.2025",
    hi: 54.0,
    holes: 18,
    gross: 126,
    courseRating: 70,
    slopeRating: 113,
    reportedDiff: 56.0,
  },
  {
    label: "Pulheim 03.04.2026 (Hans-Juergen)",
    hi: 50.9,
    holes: 9,
    gross: 48,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 47.9,
  },
  {
    label: "Pulheim 29.03.2026 (Hans-Juergen)",
    hi: 54.0,
    holes: 9,
    gross: 51,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 52.9,
  },
];

describe("golf.de PDF differential handling", () => {
  it("uses the reported golf.de differential when present", () => {
    expect(
      calcScoreDiff(
        {
          source: "golf.de-pdf",
          holes: 9,
          gbe: 48,
          courseRating: 30.1,
          slopeRating: 100,
          reportedDiff: 46.6,
        },
        48.4,
      ),
    ).toBe(46.6);
  });

  it("matches the 18-hole PDF sample using the raw formula", () => {
    expect(
      calcRawScoreDiff(
        {
          holes: 18,
          gbe: 126,
          courseRating: 70,
          slopeRating: 113,
        },
        54,
      ),
    ).toBe(56.0);
  });
});

describe("9-hole raw differential calculation against PDF samples", () => {
  it.each(pdfSampleRounds.filter(round => round.holes === 9))(
    "matches the PDF-reported differential for $label",
    ({ hi, holes, gross, courseRating, slopeRating, reportedDiff }) => {
      expect(
        calcRawScoreDiff(
          {
            holes,
            gbe: gross,
            courseRating,
            slopeRating,
          },
          hi,
        ),
      ).toBe(reportedDiff);
    },
  );
});