// Kamera-Anbindung fuer den QR-Scanner, getrennt von der Oberflaeche gehalten:
// Chrome auf Android bringt BarcodeDetector mit, Safari nicht – dort dekodiert
// jsQR die Einzelbilder. Beide Wege liefern denselben Text zurueck.

export type QrDecoder = (source: ImageData) => string | null;

export type CameraFailure = "denied" | "notfound" | "unsupported" | "error";

export function isCameraSupported() {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function hasNativeDetector() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

/** Ordnet die Ausnahmen von getUserMedia den Faellen zu, die die Oberflaeche erklaeren muss. */
export function classifyCameraError(error: unknown): CameraFailure {
  const name = (error as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "notfound";
  if (name === "NotSupportedError" || name === "TypeError") return "unsupported";
  return "error";
}

export async function startCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop());
}

/**
 * Baut die Erkennung. Bevorzugt wird die eingebaute Schnittstelle des Browsers;
 * sonst wird jsQR erst beim Oeffnen des Scanners nachgeladen, damit die
 * Bibliothek nicht im Startpaket der App liegt.
 */
export async function createDetector(): Promise<(canvas: HTMLCanvasElement) => Promise<string | null>> {
  if (hasNativeDetector()) {
    const Detector = (window as unknown as { BarcodeDetector: new (options: { formats: string[] }) => { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    const detector = new Detector({ formats: ["qr_code"] });
    return async (canvas: HTMLCanvasElement) => {
      const found = await detector.detect(canvas);
      return found[0]?.rawValue ?? null;
    };
  }

  const { default: jsQR } = await import("jsqr");
  return async (canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height) return null;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
    return result?.data ?? null;
  };
}

/** Zeichnet das aktuelle Videobild in den Puffer, aus dem die Erkennung liest. */
export function drawFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(video, 0, 0, width, height);
  return true;
}
