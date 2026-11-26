import { useEffect, useRef, useState } from 'react'
import {
  PULL_THRESHOLD,
  pullProgress,
  pulledEnough,
  resistedPull,
} from '../lib/pullToRefresh'

/**
 * 홈 화면의 당겨서 새로고침.
 *
 * The wallet scrolls with the document, so the gesture only exists in the one
 * place where the page has nowhere left to go: at the very top, with the finger
 * moving down. Until that is true the handler stays out of the way — it never
 * takes over a scroll, and it only calls `preventDefault` once the pull is
 * already happening in the overscroll region, where the browser had nothing to
 * scroll anyway.
 */
export function usePullToRefresh(onRefresh: () => void, enabled = true) {
  const [pull, setPull] = useState(0)
  const [pulling, setPulling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const gesture = useRef({ active: false, startY: 0, distance: 0 })
  const refreshingRef = useRef(false)
  const timerRef = useRef<number | undefined>(undefined)
  const onRefreshRef = useRef(onRefresh)

  onRefreshRef.current = onRefresh

  useEffect(() => {
    const host = hostRef.current
    if (!host || !enabled) return

    const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0

    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || refreshingRef.current || !atTop()) {
        gesture.current.active = false
        return
      }
      gesture.current.active = true
      gesture.current.startY = event.touches[0].clientY
      gesture.current.distance = 0
    }

    const move = (event: TouchEvent) => {
      if (!gesture.current.active) return
      if (event.touches.length !== 1) {
        gesture.current.active = false
        setPulling(false)
        setPull(0)
        return
      }
      const distance = event.touches[0].clientY - gesture.current.startY
      if (distance <= 0) {
        // The finger is going back up: this was an ordinary scroll after all.
        gesture.current.distance = 0
        setPulling(false)
        setPull(0)
        if (!atTop()) gesture.current.active = false
        return
      }
      if (!atTop()) {
        gesture.current.active = false
        setPulling(false)
        setPull(0)
        return
      }
      gesture.current.distance = distance
      if (event.cancelable) event.preventDefault()
      setPulling(true)
      setPull(resistedPull(distance))
    }

    const end = () => {
      if (!gesture.current.active) return
      gesture.current.active = false
      const distance = gesture.current.distance
      gesture.current.distance = 0
      setPulling(false)
      if (!pulledEnough(distance)) {
        setPull(0)
        return
      }
      setRefreshing(true)
      refreshingRef.current = true
      setPull(PULL_THRESHOLD)
      onRefreshRef.current()
      timerRef.current = window.setTimeout(() => {
        refreshingRef.current = false
        setRefreshing(false)
        setPull(0)
      }, 720)
    }

    host.addEventListener('touchstart', start, { passive: true })
    host.addEventListener('touchmove', move, { passive: false })
    host.addEventListener('touchend', end)
    host.addEventListener('touchcancel', end)
    return () => {
      host.removeEventListener('touchstart', start)
      host.removeEventListener('touchmove', move)
      host.removeEventListener('touchend', end)
      host.removeEventListener('touchcancel', end)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    }
  }, [enabled])

  return {
    hostRef,
    pull,
    pulling,
    progress: pullProgress(pull),
    refreshing,
  }
}
