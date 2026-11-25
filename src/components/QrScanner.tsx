import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { showToast } from './Toast'
import {
  QR_FAILURE_MESSAGE,
  startQrScanner,
  type QrFailure,
} from '../lib/qrScan'

interface QrScannerProps {
  open: boolean
  onClose: () => void
  /** Called once with the scanned text; the camera is already released. */
  onPayload: (text: string) => void
}

/**
 * Full-screen camera view behind the send sheet. Dark on purpose: the viewfinder
 * is the only bright thing on screen, and closing it is a single tap.
 *
 * Every exit path goes through `stopRef`, so the rear camera light is off the
 * moment the sheet closes — including when the person leaves by the system back
 * gesture or the component unmounts mid-scan.
 */
export function QrScanner({ open, onClose, onPayload }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  // Kept in a ref so a new inline callback from the parent does not restart
  // the camera on every render.
  const payloadRef = useRef(onPayload)
  payloadRef.current = onPayload
  const [failure, setFailure] = useState<QrFailure | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open) {
      stopRef.current?.()
      stopRef.current = null
      return
    }
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    setFailure(null)
    setStarting(true)
    void startQrScanner(video, {
      onPayload: (text) => {
        if (cancelled) return
        stopRef.current?.()
        stopRef.current = null
        payloadRef.current(text)
      },
      onFailure: (reason) => {
        if (cancelled) return
        setFailure(reason)
        setStarting(false)
        // The viewfinder says it in place; the toast is the same sentence for
        // anyone who looked away from the panel while the camera opened.
        showToast(QR_FAILURE_MESSAGE[reason])
      },
    }).then((release) => {
      if (cancelled) release()
      else {
        stopRef.current = release
        setStarting(false)
      }
    })
    return () => {
      cancelled = true
      stopRef.current?.()
      stopRef.current = null
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-[#0B0B0D] text-white">
      <div
        className="flex items-center justify-between px-5"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 14px)' }}
      >
        <span className="text-[13px] font-semibold tracking-[-0.02em]">QR 스캔</span>
        <button
          onClick={onClose}
          aria-label="QR 스캔 닫기"
          className="press -mr-1 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-8">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="h-full w-full rounded-[26px] object-cover opacity-95"
        />
        {!failure && (
          <div className="pointer-events-none absolute inset-8 flex items-center justify-center">
            <div className="h-[196px] w-[196px] rounded-[24px] border border-white/45" />
          </div>
        )}
        {failure && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            <div className="text-[14px] font-semibold">{QR_FAILURE_MESSAGE[failure]}</div>
            <div className="mt-2 text-[12px] leading-relaxed text-white/60">
              주소를 직접 붙여넣거나 입력해도 됩니다.
            </div>
            <button
              onClick={onClose}
              className="press mt-6 rounded-full bg-white px-5 py-2.5 text-[13px] font-semibold text-[#0B0B0D]"
            >
              닫기
            </button>
          </div>
        )}
      </div>

      <div
        className="px-8 pb-[calc(env(safe-area-inset-bottom)+28px)] pt-2 text-center text-[12px] leading-relaxed text-white/60"
        style={{ minHeight: 68 }}
      >
        {failure ? '' : starting ? '카메라를 여는 중…' : '송금 QR 코드를 사각형 안에 맞춰 주세요'}
      </div>
    </div>
  )
}
