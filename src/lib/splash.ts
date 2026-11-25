/**
 * 정적 스플래시(index.html)에서 앱으로 넘기는 지점.
 *
 * 스플래시는 스크립트가 실행되기 전에 이미 그려져 있으므로 첫 페인트에 빈 화면이
 * 없다. 지갑 초기화가 끝나면 여기서 한 번만 페이드아웃시키고 DOM에서 지운다.
 */

const SPLASH_ID = 'app-splash'
/**
 * 최소 노출 시간. 마스코트가 떠오르고, 우주선이 내려와 태우고, 대각선으로
 * 날아가는 한 장면(약 2.1초)이 끝까지 보이도록 잡은 값이다.
 */
const MIN_VISIBLE_MS = 2150
/** 페이드아웃 시간. index.html의 #app-splash transition과 같아야 한다. */
const FADE_MS = 350
let requested = false

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

  const elapsed = typeof performance !== 'undefined' ? performance.now() : MIN_VISIBLE_MS
  window.setTimeout(() => {
    splash.dataset.state = 'leaving'
    // transitionend는 백그라운드 탭에서 오지 않을 수 있어 시간으로도 지운다.
    window.setTimeout(() => splash.remove(), FADE_MS + 80)
  }, splashRemainingDelay(elapsed))
}
