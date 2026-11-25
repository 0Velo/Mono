/**
 * 스플래시 → 잠금 화면 착륙 연출의 좌표와 시계.
 *
 * 스플래시(index.html)의 외계인은 화면 가운데에 서 있고, 잠금 화면의
 * `MonoMark`는 키패드 위, 화면 가운데보다 위에 있다. 이 모듈은 그 두 자리
 * 사이의 이동량(dx, dy)과 축소 비율, 그리고 장면이 흐르는 시각을 계산한다.
 * 값만 다루고 DOM은 건드리지 않으므로 단위 테스트가 그대로 검증한다.
 */

/** 스플래시 마스코트 이미지(356×512 WebP)의 세로/가로 비율. */
export const ALIEN_ASPECT = 512 / 356
/**
 * 그 이미지 안에서 캐릭터가 실제로 차지하는 비율. WebP는 캐릭터에 딱 맞게
 * 잘려 있어 알파 경계가 곧 테두리다.
 */
export const ALIEN_INK = { width: 0.972, height: 0.98 }
/**
 * 잠금 화면 `MonoMark`의 상자(900×900 PNG) 안에서 캐릭터가 차지하는 비율.
 * 두 장의 마스터(라이트·다크)가 같은 실루엣이라 한 값으로 충분하다.
 */
export const MARK_INK = { width: 0.612, height: 0.89 }

/**
 * 한 장면의 박자. 스플래시 첫 페인트를 0으로 본 절대 시각과, 착륙을 시작한
 * 순간부터의 상대 시각을 같은 값으로 쓴다(시작이 늦으면 그만큼 밀린다).
 */
export const LANDING_BEAT = {
  /** 우주선이 외계인을 데리고 출발하는 시각(스플래시 첫 페인트 기준). */
  startAt: 1080,
  /** 잠금 화면 마스코트 자리까지 내려가는 시간. */
  carryMs: 560,
  /** 내려놓은 뒤 우주선이 뜨기 전의 한 박자. */
  settleMs: 130,
  /** 우주선이 위로·옆으로 사라지는 시간. */
  shipOutMs: 460,
  /** 실제 `MonoMark`가 자리를 넘겨받는 교차 시간. */
  handoffMs: 220,
  /** 우주선이 사라진 뒤 스플래시가 발을 떼기까지. */
  tailMs: 100,
} as const

export interface LandingBox {
  left: number
  top: number
  width: number
  height: number
}

export interface LandingPoint {
  x: number
  y: number
}

export function centreOf(box: LandingBox): LandingPoint {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

export interface LandingTransform {
  dx: number
  dy: number
  scale: number
}

/**
 * 외계인을 잠금 화면 마스코트 자리에 내려놓는 변환.
 *
 * 크기는 상자 크기가 아니라 **캐릭터의 키**로 맞춘다. 두 그림은 같은 렌더를
 * 다르게 잘라 낸 것이라(WebP는 캐릭터에 붙여서, PNG는 여백을 두고) 상자를
 * 맞추면 캐릭터가 튀어 보인다. 캐릭터 높이를 같게 두면 마지막 교차에서
 * 크기가 변하지 않는다.
 */
export function landingTransform(input: {
  alienWidth: number
  start: LandingPoint
  target: LandingPoint
  markHeight: number
}): LandingTransform {
  const alienInk = input.alienWidth * ALIEN_ASPECT * ALIEN_INK.height
  const markInk = input.markHeight * MARK_INK.height
  const raw = alienInk > 0 && markInk > 0 ? markInk / alienInk : 1
  const scale = Math.min(1, Math.max(0.05, raw))
  return {
    dx: Math.round((input.target.x - input.start.x) * 10) / 10,
    dy: Math.round((input.target.y - input.start.y) * 10) / 10,
    scale: Math.round(scale * 1000) / 1000,
  }
}

export interface LandingTiming {
  /** 지금 착륙을 걸면 우주선이 출발하기까지 기다릴 시간. */
  delayMs: number
  /** 외계인이 막 도착하는 시각(착륙을 건 순간부터). */
  arriveMs: number
  /** 잠금 화면의 진짜 마크가 그 자리에 나타나기 시작하는 시각. */
  markInMs: number
  /** 날아온 외계인이 자기 모습을 감추기 시작하는 시각. */
  handoffMs: number
  /** 우주선이 뜨기 시작하는 시각. */
  shipOutMs: number
  /** 잠금 화면의 글자·키패드가 떠오르기 시작하는 시각. */
  contentInMs: number
  /** 우주선까지 완전히 사라지는 시각 — 스플래시는 이때까지 남는다. */
  holdMs: number
}

/**
 * 장면의 시계. `ageMs`는 스플래시가 첫 페인트된 뒤 흐른 시간이라, 앱이 늦게
 * 준비될수록 출발을 그만큼 기다리지 않고 바로 시작한다(이미 지난 박자는 접는다).
 *
 * 넘겨주기는 겹치기보다 순서를 둔다: 진짜 마크가 먼저 그 자리에 서고, 그 위에서
 * 날아온 외계인이 사라진다. 둘이 반투명하게 겹치면 같은 캐릭터가 잠긴 듯 뿌옇게
 * 보이기 때문이다.
 */
export function landingTiming(ageMs: number, beat = LANDING_BEAT): LandingTiming {
  const age = Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0
  const delayMs = Math.max(0, Math.round(beat.startAt - age))
  const arriveMs = delayMs + beat.carryMs
  return {
    delayMs,
    arriveMs,
    markInMs: arriveMs + 50,
    handoffMs: arriveMs + 110,
    shipOutMs: arriveMs + 150,
    contentInMs: delayMs + 400,
    holdMs: arriveMs + beat.settleMs + beat.shipOutMs + beat.tailMs,
  }
}
