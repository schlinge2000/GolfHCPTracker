import { describe, expect, it } from "vitest";

import { classifyCameraError, hasNativeDetector, isCameraSupported } from "./qrScanner";

describe("classifyCameraError", () => {
  it("unterscheidet die Fälle, die der Nutzer verschieden lösen muss", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyCameraError({ name: "SecurityError" })).toBe("denied");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("notfound");
    expect(classifyCameraError({ name: "OverconstrainedError" })).toBe("notfound");
    expect(classifyCameraError({ name: "NotSupportedError" })).toBe("unsupported");
    expect(classifyCameraError({ name: "TypeError" })).toBe("unsupported");
  });

  it("fällt bei allem anderen auf einen allgemeinen Fehler zurück", () => {
    expect(classifyCameraError(new Error("kaputt"))).toBe("error");
    expect(classifyCameraError(null)).toBe("error");
    expect(classifyCameraError(undefined)).toBe("error");
    expect(classifyCameraError("Zeichenkette")).toBe("error");
  });
});

describe("Fähigkeiten des Browsers", () => {
  it("meldet keine Kamera, wenn getUserMedia fehlt", () => {
    // In der Testumgebung gibt es weder navigator.mediaDevices noch BarcodeDetector.
    expect(isCameraSupported()).toBe(false);
    expect(hasNativeDetector()).toBe(false);
  });
});
