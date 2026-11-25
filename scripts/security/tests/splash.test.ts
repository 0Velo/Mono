/**
 * 첫 로딩 화면(스플래시) — 정적 셸과 핸드오프.
 *
 * 스플래시는 스크립트 없이 그려져야 첫 페인트가 비지 않고, 앱이 준비되면
 * 한 번만 사라져야 한다. 여기서는 그 두 가지를 소스와 DOM 없이 확인한다.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, readRepoFile } from './helpers'
import { hideAppSplash, splashRemainingDelay } from '../../../src/lib/splash'

const SPLASH_ASSET = 'public/assets/splash/mono-alien.webp'

test('index.html paints the mascot splash before any script runs', () => {
  const html = readRepoFile('index.html')
  assert.match(html, /<div id="app-splash"/)
  assert.match(html, /assets\/splash\/mono-alien\.webp/)
  assert.ok(
    html.indexOf('id="app-splash"') < html.indexOf('<script type="module"'),
    'the splash must be in the markup before the module script',
  )
  // A splash that needs JS cannot cover the blank first frame.
  assert.ok(!/getElementById\('app-splash'\)\s*\)?\.innerHTML/.test(html))
})

test('the splash follows the OS theme and the saved theme, with a dark rim for the matte mascot', () => {
  const html = readRepoFile('index.html')
  assert.match(html, /@media \(prefers-color-scheme: dark\)/)
  assert.match(html, /html\[data-theme='dark'\] #app-splash/)
  assert.match(html, /html\[data-theme='light'\] #app-splash/)
  assert.match(html, /drop-shadow/)
  assert.match(html, /prefers-reduced-motion: reduce/)
})

test('the mascot asset is a small transparent WebP, not a megabyte PNG', () => {
  const absolute = path.join(REPO_ROOT, SPLASH_ASSET)
  assert.ok(fs.existsSync(absolute), `${SPLASH_ASSET} must exist`)
  const bytes = fs.readFileSync(absolute)
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP')
  assert.ok(bytes.length < 60 * 1024, `splash art is ${bytes.length} bytes; keep the first paint light`)
})

test('the splash is held long enough to be seen, then never replayed', () => {
  assert.equal(splashRemainingDelay(0), 2150)
  assert.equal(splashRemainingDelay(200), 1950)
  assert.equal(splashRemainingDelay(2150), 0)
  assert.equal(splashRemainingDelay(5000), 0)
  assert.equal(splashRemainingDelay(Number.NaN), 2150)

  const g = globalThis as unknown as {
    window?: unknown
    document?: unknown
  }
  const timers: Array<{ fn: () => void; ms: number }> = []
  const removed: string[] = []
  const splash = {
    dataset: {} as Record<string, string>,
    remove: () => removed.push('removed'),
  }
  g.window = {
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    },
  }
  g.document = { getElementById: (id: string) => (id === 'app-splash' ? splash : null) }

  hideAppSplash()
  assert.equal(timers.length, 1, 'one delay before the fade starts')
  timers[0].fn()
  assert.equal(splash.dataset.state, 'leaving')
  assert.equal(timers.length, 2, 'a timer removes the node even if transitionend never fires')
  timers[1].fn()
  assert.deepEqual(removed, ['removed'])

  // A second call (App ready, then the safety timeout) must not schedule again.
  hideAppSplash()
  assert.equal(timers.length, 2)

  delete g.window
  delete g.document
})

test('the mascot enters, floats and breathes instead of just appearing', () => {
  const html = readRepoFile('index.html')
  // The wrapper drifts; the mascot scales in and breathes. Separate layers so
  // the two transform animations never overwrite each other.
  assert.match(html, /class="splash-mark"/)
  assert.match(html, /@keyframes splash-float/)
  assert.match(html, /@keyframes splash-breathe/)
  assert.match(html, /animation:\s*splash-float[^;]*infinite/)
  assert.match(html, /splash-breathe[^;]*infinite/)
  assert.match(html, /@keyframes splash-enter/)
  assert.match(html, /transition: opacity 350ms ease/)
  // Motion sickness settings still win: no float, no breathing.
  const reduce = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(reduce, /#app-splash \.splash-mark \{\s*animation: none;/)
})

test('a clay saucer lands, lifts the mascot aboard and carries it off in ~2.5 s', () => {
  const html = readRepoFile('index.html')
  const splash = readRepoFile('src/lib/splash.ts')

  // Hold plus fade is the whole beat the brief asks for: about 2.5 seconds.
  assert.match(splash, /const MIN_VISIBLE_MS = 2150/)
  assert.match(splash, /const FADE_MS = 350/)

  // The ship is drawn in the document itself: no extra file, no script.
  assert.match(html, /<svg class="splash-ufo" viewBox="0 0 240 152"/)
  assert.match(html, /<div class="splash-beam"><\/div>/)
  assert.match(html, /@keyframes splash-ship-in/)
  assert.match(html, /@keyframes splash-board/)
  assert.match(html, /@keyframes splash-beam/)
  assert.match(html, /@keyframes splash-flame/)
  assert.match(html, /@keyframes splash-launch/)

  // The ship comes after the mascot has been seen, and the flight is last.
  const order = (name: string) => html.indexOf(`@keyframes ${name}`)
  assert.ok(order('splash-enter') < order('splash-ship-in'), 'the saucer waits for the mascot')
  assert.ok(order('splash-ship-in') < order('splash-board'), 'the saucer arrives before the lift')

  // The whole stage, not a stray layer, is what leaves the frame.
  assert.match(html, /#app-splash \.splash-stage \{[^}]*animation: splash-launch/)
  assert.match(html, /#app-splash \.splash-alien \{[^}]*animation: splash-board/)

  // No flight, beam or twinkle for anyone who asked motion to be reduced.
  const reduce = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(reduce, /#app-splash \.splash-stage,[\s\S]*\.splash-alien,[\s\S]*\{\s*animation: none;/)
  assert.match(reduce, /#app-splash \.splash-ship,[\s\S]*\{\s*display: none;/)
})

test('the service worker cache moved past the previous build', () => {
  const sw = readRepoFile('public/sw.js')
  const version = Number(sw.match(/CACHE = `\$\{CACHE_PREFIX\}v(\d+)`/)?.[1])
  assert.ok(Number.isFinite(version) && version >= 14, `service worker cache version is ${version}`)
})
