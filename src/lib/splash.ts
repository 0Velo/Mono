/**
 * 정적 스플래시(index.html)에서 앱으로 넘기는 지점.
 *
 * 스플래시는 스크립트가 실행되기 전에 이미 그려져 있으므로 첫 페인트에 빈 화면이
 * 없다. 지갑 초기화가 끝나면 여기서 한 번만 페이드아웃시키고 DOM에서 지운다.
 *
 * 지갑이 있어 잠금 화면으로 들어가는 경우에는 장면이 그냥 끝나지 않는다.
 * `beginSplashLanding()`이 잠금 화면의 마스코트 자리를 재서, 우주선이 외계인을
 * 그 자리에 작아지며 내려놓고 떠나는 착륙 연출로 넘긴다(index.html의
 * `data-mode="land"` 규칙 + `splashLanding.ts`의 좌표·시계).
 */
import { centreOf, landingTiming, landingTransform } from './splashLanding'

const SPLASH_ID = 'app-splash'
/**
 * 스플래시가 그려진 뒤 유지할 시간. 마스코트가 떠오르고, 우주선이 내려와 태우고,
 * 대각선으로 날아가고, 그 자리에 `Mono` 워드마크가 떠올라 읽히는 한 장면
 * (발진 1.82초 → 워드마크 1.86~2.34초)이 끝까지 보이도록 잡은 값이다.
 * 페이드(350ms)까지 합치면 약 2.8초. 착륙 연출도 이 안에서 끝난다.
 */
const MIN_VISIBLE_MS = 2450
/** 페이드아웃 시간. index.html의 #app-splash transition과 같아야 한다. */
const FADE_MS = 350
let requested = false
/** 착륙 연출이 끝나는 시각(ms). 착륙을 걸지 않았으면 0. */
let landingHoldMs = 0

/**
 * 스플래시가 화면에 그려진 뒤 흐른 시간(ms). 알 수 없으면 NaN.
 *
 * CSS 애니메이션은 문서를 파싱해 스플래시가 처음 그려진 순간 시작하므로, 네트워크가
 * 느린 기기에서는 `performance.now()`(탐색 시작 기준)보다 이 시계가 더 늦다. 두
 * 시계를 맞추지 않으면 우주선이 날아가는 마지막 장면이 페이드에 잘린다.
 */
function splashAgeMs(splash: HTMLElement): number {
  if (typeof splash.getAnimations !== 'function' || typeof performance === 'undefined') {
    return Number.NaN
  }
  const starts = splash
    .getAnimations({ subtree: true })
    .map((animation) => animation.startTime)
    .filter((start): start is number => typeof start === 'number')
  if (starts.length === 0) return Number.NaN
  return performance.now() - Math.min(...starts)
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * 작아지며 내려앉을 외계인의 출발점. 스플래시는 세로 flex 가운데 정렬이라
 * 무대의 레이아웃 상자가 곧 화면 가운데다. 무대의 변환(발진)이 이미 걸려 있어도
 * 흔들리지 않도록 레이아웃 좌표를 먼저 쓴다.
 */
function stageCentre(stage: HTMLElement, splash: HTMLElement): { x: number; y: number } {
  if (stage.offsetParent === splash && stage.offsetWidth > 0) {
    return { x: stage.offsetLeft + stage.offsetWidth / 2, y: stage.offsetTop + stage.offsetHeight / 2 }
  }
  const box = stage.getBoundingClientRect()
  return centreOf(box)
}

/**
 * 잠금 화면으로 들어가는 스플래시를 착륙 연출로 돌린다.
 *
 * 성공하면 스플래시가 스스로 사라질 시각을 `landingHoldMs`에 남기고 true.
 * 대상(잠금 화면 마스코트)이 없거나, 모션을 줄여 달라고 했거나, 이미 착륙을
 * 걸었으면 아무것도 바꾸지 않고 false — 그때는 온보딩과 같은 기존 마무리
 * (우주선 발진 + `Mono` 워드마크)가 그대로 흐른다.
 */
export function beginSplashLanding(): boolean {
  if (typeof document === 'undefined') return false
  const splash = document.getElementById(SPLASH_ID)
  if (!splash || splash.dataset.mode) return false
  if (prefersReducedMotion()) return false

  const stage = splash.querySelector<HTMLElement>('.splash-stage')
  const alien = splash.querySelector<HTMLImageElement>('.splash-alien img')
  const target = document.querySelector<HTMLElement>('[data-mono-landing-target]')
  if (!stage || !alien || !target) return false

  const alienWidth = alien.offsetWidth || stage.offsetWidth
  const targetBox = target.getBoundingClientRect()
  // 레이아웃이 아직 잡히지 않았으면 엉뚱한 곳으로 날아가느니 기존 마무리를 쓴다.
  if (alienWidth < 8 || targetBox.width < 8 || targetBox.height < 8) return false

  const transform = landingTransform({
    alienWidth,
    start: stageCentre(stage, splash),
    target: centreOf(targetBox),
    markHeight: targetBox.height,
  })
  if (!Number.isFinite(transform.dx) || !Number.isFinite(transform.dy)) return false

  const timing = landingTiming(splashAgeMs(splash))
  const root = document.documentElement
  splash.style.setProperty('--land-dx', `${transform.dx}px`)
  splash.style.setProperty('--land-dy', `${transform.dy}px`)
  splash.style.setProperty('--land-s', `${transform.scale}`)
  splash.style.setProperty('--land-delay', `${timing.delayMs}ms`)
  splash.style.setProperty('--land-handoff', `${timing.handoffMs}ms`)
  splash.style.setProperty('--land-ship-out', `${timing.shipOutMs}ms`)
  root.style.setProperty('--mono-land-content-in', `${timing.contentInMs}ms`)
  root.style.setProperty('--mono-land-handoff', `${timing.markInMs}ms`)
  splash.dataset.mode = 'land'
  root.classList.add('mono-landing')
  landingHoldMs = timing.holdMs
  return true
}

/**
 * 스플래시를 최소 노출 시간까지 유지한 뒤 사라지게 한다.
 * 앱이 아주 빨리 뜨는 기기에서 로고가 깜빡이고 마는 것을 막는다.
 * 착륙 연출이 걸렸으면 그 장면이 끝날 때까지 기다린다.
 */
export function splashRemainingDelay(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return MIN_VISIBLE_MS
  return Math.max(0, MIN_VISIBLE_MS - elapsedMs)
}

export function hideAppSplash(): void {
  if (requested || typeof document === 'undefined') return
  requested = true
  const splash = document.getElementById(SPLASH_ID)
  if (!splash) return

  const remaining = Math.max(splashRemainingDelay(splashAgeMs(splash)), landingHoldMs)
  window.setTimeout(() => {
    splash.dataset.state = 'leaving'
    // transitionend는 백그라운드 탭에서 오지 않을 수 있어 시간으로도 지운다.
    window.setTimeout(() => {
      splash.remove()
      document.documentElement?.classList.remove('mono-landing')
    }, FADE_MS + 80)
  }, remaining)
}
