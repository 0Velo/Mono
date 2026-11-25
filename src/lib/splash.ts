/**
 * 정적 스플래시(index.html)에서 앱으로 넘기는 지점.
 *
 * 스플래시는 스크립트가 실행되기 전에 이미 그려져 있으므로 첫 페인트에 빈 화면이
 * 없다. 지갑 초기화가 끝나면 여기서 한 번만 페이드아웃시키고 DOM에서 지운다.
 */

const SPLASH_ID = 'app-splash'
/**
 * 스플래시가 그려진 뒤 유지할 시간. 마스코트가 떠오르고, 우주선이 내려와 태우고,
 * 대각선으로 날아가는 한 장면(약 2.1초)이 끝까지 보이도록 잡은 값이다.
 */
const MIN_VISIBLE_MS = 2150
/** 페이드아웃 시간. index.html의 #app-splash transition과 같아야 한다. */
const FADE_MS = 350
let requested = false

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

/**
 * 스플래시를 최소 노출 시간까지 유지한 뒤 사라지게 한다.
 * 앱이 아주 빨리 뜨는 기기에서 로고가 깜빡이고 마는 것을 막는다.
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

  window.setTimeout(() => {
    splash.dataset.state = 'leaving'
    // transitionend는 백그라운드 탭에서 오지 않을 수 있어 시간으로도 지운다.
    window.setTimeout(() => splash.remove(), FADE_MS + 80)
  }, splashRemainingDelay(splashAgeMs(splash)))
}
