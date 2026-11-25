/**
 * 스플래시 → 잠금 화면 착륙 연출.
 *
 * 지갑이 있어 잠금 화면으로 들어갈 때, 우주선은 스플래시 속 외계인을 키패드 위
 * `MonoMark` 자리까지 데려가 그 마크의 실제 크기로 줄여 내려놓고 떠나야 한다.
 * 여기서는 (1) 두 그림의 캐릭터 크기를 맞추는 좌표 계산, (2) 박자, (3) 스플래시가
 * 그 장면이 끝날 때까지 기다리는지, (4) 온보딩·모션 감소에서는 예전 마무리로
 * 남는지를 확인한다.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALIEN_ASPECT,
  ALIEN_INK,
  LANDING_BEAT,
  MARK_INK,
  centreOf,
  landingTiming,
  landingTransform,
} from '../../../src/lib/splashLanding'
import { beginSplashLanding, hideAppSplash } from '../../../src/lib/splash'
import { readRepoFile } from './helpers'

/* 430×900 화면에서 실제로 재어진 값: 스플래시 마스코트 상자(189×272)와
 * 잠금 화면 마크 자리(92×92, 화면 가운데보다 232px 위). */
const ALIEN_WIDTH = 189
const START = { x: 214.5, y: 450 }
const TARGET = { x: 215, y: 218 }
const MARK_SIZE = 92

test('the alien is shrunk to the mark’s own character size, not its box', () => {
  const { dx, dy, scale } = landingTransform({
    alienWidth: ALIEN_WIDTH,
    start: START,
    target: TARGET,
    markHeight: MARK_SIZE,
  })

  // Straight up, over the keypad and onto the mark above it.
  assert.equal(dx, 0.5)
  assert.equal(dy, -232)
  assert.ok(scale > 0.29 && scale < 0.33, `scale was ${scale}`)

  // Both artworks are crops of the same render, so what has to match is the
  // character inside them: at the end the alien's ink is exactly the mark's.
  const alienInkHeight = ALIEN_WIDTH * ALIEN_ASPECT * ALIEN_INK.height * scale
  const alienInkWidth = ALIEN_WIDTH * ALIEN_INK.width * scale
  assert.ok(Math.abs(alienInkHeight - MARK_SIZE * MARK_INK.height) < 0.3)
  assert.ok(Math.abs(alienInkWidth - MARK_SIZE * MARK_INK.width) < 0.6)

  // The box centre lands on the mark's centre, so the swap has nowhere to jump.
  assert.ok(Math.abs(START.x + dx - TARGET.x) < 0.8)
  assert.ok(Math.abs(START.y + dy - TARGET.y) < 0.8)
})

test('the landing never grows the alien or divides by a missing size', () => {
  const tiny = landingTransform({ alienWidth: 8, start: START, target: TARGET, markHeight: 400 })
  assert.ok(tiny.scale <= 1, `scale was ${tiny.scale}`)
  const empty = landingTransform({ alienWidth: 0, start: START, target: START, markHeight: MARK_SIZE })
  assert.equal(empty.scale, 1)
  assert.ok(Number.isFinite(empty.dx) && Number.isFinite(empty.dy))
})

test('the beat leaves as soon as the intro is over, and still fits the splash', () => {
  const early = landingTiming(300)
  assert.equal(early.delayMs, LANDING_BEAT.startAt - 300)
  // Carried down, set down, saucer away.
  assert.equal(early.arriveMs, early.delayMs + LANDING_BEAT.carryMs)
  assert.ok(early.markInMs <= early.handoffMs, 'the real mark stands up first')
  assert.ok(early.handoffMs <= early.shipOutMs, 'the saucer leaves after letting go')
  assert.ok(early.shipOutMs < early.holdMs)
  // The whole landing is over inside the splash's usual 2.45 s hold, so the
  // launch the app has after startup is not stretched by it.
  assert.ok(early.holdMs <= 2450, `landing ended at ${early.holdMs}ms`)
  // The lock screen's own text arrives while the mark is being set down.
  assert.ok(early.contentInMs > LANDING_BEAT.carryMs / 2)
  assert.ok(early.contentInMs < early.holdMs)

  // A slow start must not push the scene later than the splash's own clock.
  const late = landingTiming(4000)
  assert.equal(late.delayMs, 0)
  assert.equal(late.holdMs, LANDING_BEAT.carryMs + LANDING_BEAT.settleMs + LANDING_BEAT.shipOutMs + LANDING_BEAT.tailMs)
  // Unknown clock: start now rather than wait forever.
  assert.equal(landingTiming(Number.NaN).delayMs, LANDING_BEAT.startAt)
  assert.equal(landingTiming(-5).delayMs, LANDING_BEAT.startAt)
})

test('centreOf is the middle of the measured box', () => {
  assert.deepEqual(centreOf({ left: 169, top: 172, width: 92, height: 92 }), { x: 215, y: 218 })
})

test('the splash markup carries the landing ending only next to a lock-screen target', () => {
  const html = readRepoFile('index.html')
  const landing = readRepoFile('src/screens/LockScreen.tsx')
  const app = readRepoFile('src/App.tsx')

  // The saucer, the beam and the alien are the ones already in the document:
  // no new script, no second copy of the artwork.
  for (const keyframe of ['splash-land-carry', 'splash-land-ship-out', 'splash-land-set']) {
    assert.match(html, new RegExp(`@keyframes ${keyframe}`))
  }
  assert.match(html, /#app-splash\[data-mode='land'\] \.splash-stage \{[\s\S]*?animation: splash-land-carry/)
  assert.match(html, /var\(--land-dx/)
  assert.match(html, /var\(--land-dy/)
  assert.match(html, /var\(--land-s/)
  // The sheet lifts, and the wordmark belongs to the onboarding ending only.
  assert.match(html, /html #app-splash\[data-mode='land'\] \{\s*background-color: transparent;/)
  assert.match(html, /#app-splash\[data-mode='land'\] \.splash-word \{\s*animation: none;\s*opacity: 0;/)
  // The landing block is skipped entirely when motion is reduced.
  const block = html.slice(html.indexOf('@keyframes splash-land-carry'), html.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.ok(block.indexOf("@media (prefers-reduced-motion: no-preference)") >= 0)
  const rules = html.slice(html.indexOf("#app-splash[data-mode='land']"))
  assert.ok(!/<script/i.test(rules.slice(0, 6000)), 'no inline script in the landing rules')

  // The lock screen offers the slot and hides the mark until it is handed over.
  assert.match(landing, /data-mono-landing-target/)
  assert.match(landing, /mono-land-mark/)
  assert.match(landing, /mono-lock-content/)
  // ...and the app starts the landing exactly where the splash is dismissed.
  assert.match(app, /if \(vaultExists && !unlocked\) beginSplashLanding\(\)\s*\n\s*hideAppSplash\(\)/)
})

test('the splash waits for the landing before it fades out', () => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown }
  const timers: Array<{ fn: () => void; ms: number }> = []
  const removed: string[] = []
  const classes: string[] = []
  const vars: Record<string, string> = {}

  // The splash has already been painted for 300 ms when the vault is read.
  const paintedAt = performance.now() - 300
  const stage = {
    offsetParent: null as unknown,
    offsetLeft: 120,
    offsetTop: 314,
    offsetWidth: ALIEN_WIDTH,
    offsetHeight: 272,
  }
  const alienImage = { offsetWidth: ALIEN_WIDTH }
  const splash = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => {
        vars[name] = value
      },
    },
    getAnimations: () => [{ startTime: paintedAt }],
    querySelector: (selector: string) => {
      if (selector === '.splash-stage') return stage
      if (selector === '.splash-alien img') return alienImage
      return null
    },
    remove: () => removed.push('removed'),
  }
  stage.offsetParent = splash
  const target = {
    getBoundingClientRect: () => ({ left: 169, top: 172, width: 92, height: 92 }),
  }
  const root = {
    style: { setProperty: () => {} },
    classList: { add: (name: string) => classes.push(name), remove: () => {} },
  }
  g.window = {
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    },
    matchMedia: () => ({ matches: false }),
  }
  g.document = {
    getElementById: (id: string) => (id === 'app-splash' ? splash : null),
    querySelector: (selector: string) => (selector === '[data-mono-landing-target]' ? target : null),
    documentElement: root,
  }

  assert.equal(beginSplashLanding(), true)
  assert.equal(splash.dataset.mode, 'land')
  assert.deepEqual(classes, ['mono-landing'])
  // The measured journey goes into custom properties, not into the markup.
  assert.equal(vars['--land-dy'], '-232px')
  assert.equal(vars['--land-dx'], '0.5px')
  assert.ok(Number(vars['--land-s']) > 0.29 && Number(vars['--land-s']) < 0.33)
  const delay = Number(vars['--land-delay'].replace('ms', ''))
  assert.ok(delay >= LANDING_BEAT.startAt - 320 && delay <= LANDING_BEAT.startAt - 300, `delay was ${vars['--land-delay']}`)

  // Held from paint as usual, but at least until the saucer has flown away.
  hideAppSplash()
  assert.equal(timers.length, 1)
  const landingHold = LANDING_BEAT.carryMs + LANDING_BEAT.settleMs + LANDING_BEAT.shipOutMs + LANDING_BEAT.tailMs
  assert.ok(timers[0].ms > landingHold, 'the splash must outlast the landing')
  assert.ok(timers[0].ms <= 2450, 'the usual hold is enough for this landing')

  // A second call (the 8 s safety net) must not schedule anything again.
  hideAppSplash()
  assert.equal(timers.length, 1)

  // Reduced motion, or an app already gone, leaves the usual ending alone.
  ;(g.window as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: true })
  delete splash.dataset.mode
  assert.equal(beginSplashLanding(), false)
  assert.equal(splash.dataset.mode, undefined)

  delete g.window
  delete g.document
})

test('the service worker cache moved past the landed build', () => {
  const sw = readRepoFile('public/sw.js')
  const version = Number(sw.match(/CACHE = `\$\{CACHE_PREFIX\}v(\d+)`/)?.[1])
  assert.ok(Number.isFinite(version) && version >= 19, `service worker cache version is ${version}`)
  // Each shipped feature set keeps its own line in the service worker history;
  // the landing build (v18) must still be described, and so must this one.
  assert.match(sw, /v18 \(Mono\)/)
  assert.match(sw, /v19 \(Mono\)/)
})
