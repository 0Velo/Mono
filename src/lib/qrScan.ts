/**
 * Rear-camera QR scanning for the send sheet.
 *
 * Two decoders, one interface: `BarcodeDetector` when the browser ships it
 * (Chrome/Android), and a bundled pure-JS decoder (`jsqr`) everywhere else,
 * specifically iOS Safari. The fallback is imported as its own chunk the moment
 * the first frame needs it, so the initial bundle never carries it. No CDN, no
 * remote script — the Content-Security-Policy keeps `script-src 'self'` and
 * this code honours it.
 *
 * The camera is a borrowed resource: the stream is released the instant the
 * caller runs the returned stop function, which the scanner UI calls when it
 * closes, when a code is read, and when the component unmounts.
 */
export type QrFailure = 'insecure' | 'unsupported' | 'permission' | 'camera'

export interface QrScanHandlers {
  onPayload: (text: string) => void
  onFailure: (reason: QrFailure) => void
}

export const QR_FAILURE_MESSAGE: Record<QrFailure, string> = {
  insecure: '카메라는 HTTPS에서만 열 수 있습니다',
  unsupported: '이 브라우저는 카메라 스캔을 지원하지 않습니다',
  permission: '카메라 권한이 거부됐습니다 · 브라우저 설정에서 허용해 주세요',
  camera: '카메라를 열 수 없습니다',
}

export function cameraFailureReason(error: unknown): QrFailure {
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'permission'
  }
  if (name === 'NotSupportedError') return 'unsupported'
  return 'camera'
}

/**
 * Scanned text arrives with the padding a camera can add (a trailing newline,
 * spaces around the payload). Base58 and URI text never contain a line break,
 * so those are removed rather than left to fail the address check.
 */
export function normalizeScannedText(text: string): string {
  return text.replace(/[\r\n\t]+/g, '').trim()
}

interface DetectedCode {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const candidate = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof candidate === 'function' ? candidate : null
}

/** Longest side of the frames handed to the JS decoder; smaller decodes faster. */
const DECODE_MAX_SIDE = 480
const SCAN_INTERVAL_MS = 180

type JsDecode = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: string }) => { data: string } | null

let decoderPromise: Promise<JsDecode> | null = null

/** The bundled fallback decoder, fetched once and only when a frame needs it. */
async function loadJsDecoder(): Promise<JsDecode> {
  if (!decoderPromise) {
    decoderPromise = import('jsqr').then((module) => module.default as unknown as JsDecode)
  }
  return decoderPromise
}

function drawFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): ImageData | null {
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) return null
  const scale = Math.min(1, DECODE_MAX_SIDE / Math.max(width, height))
  const frameWidth = Math.max(1, Math.round(width * scale))
  const frameHeight = Math.max(1, Math.round(height * scale))
  if (canvas.width !== frameWidth) canvas.width = frameWidth
  if (canvas.height !== frameHeight) canvas.height = frameHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(video, 0, 0, frameWidth, frameHeight)
  return context.getImageData(0, 0, frameWidth, frameHeight)
}

/**
 * Opens the rear camera on `video` and calls `onPayload` with the first text a
 * QR frame decodes to. Returns the release function; it is always safe to call,
 * and the camera is never left running behind a closed sheet.
 */
export async function startQrScanner(
  video: HTMLVideoElement,
  handlers: QrScanHandlers,
): Promise<() => void> {
  if (!window.isSecureContext) {
    handlers.onFailure('insecure')
    return () => {}
  }
  const media = navigator.mediaDevices
  if (!media?.getUserMedia) {
    handlers.onFailure('unsupported')
    return () => {}
  }

  let stream: MediaStream
  try {
    stream = await media.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
  } catch (error) {
    const reason = cameraFailureReason(error)
    // A device that cannot satisfy `facingMode` may still have a camera.
    if (reason === 'camera' && (error as { name?: string })?.name === 'OverconstrainedError') {
      try {
        stream = await media.getUserMedia({ video: true, audio: false })
      } catch (retryError) {
        handlers.onFailure(cameraFailureReason(retryError))
        return () => {}
      }
    } else {
      handlers.onFailure(reason)
      return () => {}
    }
  }

  let stopped = false
  let timer: number | undefined
  const canvas = document.createElement('canvas')

  const release = () => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) window.clearTimeout(timer)
    stream.getTracks().forEach((track) => {
      try {
        track.stop()
      } catch {
        /* already ended */
      }
    })
    if (video.srcObject === stream) video.srcObject = null
  }

  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  try {
    await video.play()
  } catch {
    // Autoplay may be refused until the element is visible; the first frame
    // read will simply find nothing and try again.
  }
  if (stopped) return release

  const Detector = barcodeDetectorCtor()
  const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null

  const finish = (raw: string) => {
    const text = normalizeScannedText(raw)
    if (!text) return
    release()
    handlers.onPayload(text)
  }

  const tick = async () => {
    if (stopped) return
    if (video.readyState >= 2) {
      try {
        if (detector) {
          const codes = await detector.detect(video)
          const value = codes.find((code) => code.rawValue)?.rawValue
          if (value) return finish(value)
        } else {
          const frame = drawFrame(video, canvas)
          if (frame) {
            const decode = await loadJsDecoder()
            const decoded = decode(frame.data, frame.width, frame.height, {
              inversionAttempts: 'dontInvert',
            })
            if (decoded?.data) return finish(decoded.data)
          }
        }
      } catch {
        // A decoder that throws on one frame (blur, rotation) must not end the
        // scan; the next frame gets its own chance.
      }
    }
    if (!stopped) timer = window.setTimeout(() => void tick(), SCAN_INTERVAL_MS)
  }

  timer = window.setTimeout(() => void tick(), SCAN_INTERVAL_MS)
  return release
}
