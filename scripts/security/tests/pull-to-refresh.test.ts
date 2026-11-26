/**
 * 당겨서 새로고침 — 손가락 거리에서 새로고침 여부까지.
 *
 * 화면 없이 계산만 확인한다: 짧게 튕긴 손가락은 스크롤이고, 임계치를 넘겨
 * 끌어내린 손가락만 새로고침이며, 아무리 세게 당겨도 인디케이터는 정해진
 * 높이에서 멈춘다.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PULL_MAX,
  PULL_THRESHOLD,
  pullProgress,
  pulledEnough,
  resistedPull,
} from '../../../src/lib/pullToRefresh'

test('a downward drag moves the indicator less than the finger', () => {
  assert.equal(resistedPull(0), 0)
  assert.equal(resistedPull(-40), 0)
  assert.ok(resistedPull(100) < 100)
  assert.ok(resistedPull(100) > 0)
})

test('the indicator stops at its ceiling however hard the pull', () => {
  assert.equal(resistedPull(10_000), PULL_MAX)
  assert.equal(resistedPull(PULL_MAX * 4), PULL_MAX)
  assert.ok(PULL_MAX > PULL_THRESHOLD)
})

test('releasing under the threshold does not refresh', () => {
  assert.equal(pulledEnough(0), false)
  assert.equal(pulledEnough(40), false)
  // 64px of indicator travel needs ~116px of finger travel.
  assert.equal(pulledEnough(PULL_THRESHOLD / 0.55 - 1), false)
})

test('releasing past the threshold refreshes', () => {
  const finger = PULL_THRESHOLD / 0.55 + 1
  assert.equal(pulledEnough(finger), true)
  assert.equal(pulledEnough(160), true)
})

test('progress fills to exactly one at the threshold and never beyond', () => {
  assert.equal(pullProgress(0), 0)
  assert.equal(pullProgress(-10), 0)
  assert.ok(pullProgress(PULL_THRESHOLD / 2) > 0.4)
  assert.ok(pullProgress(PULL_THRESHOLD / 2) < 0.6)
  assert.equal(pullProgress(PULL_THRESHOLD), 1)
  assert.equal(pullProgress(PULL_MAX), 1)
})

test('a NaN or infinite travel is treated as no pull', () => {
  assert.equal(resistedPull(Number.NaN), 0)
  assert.equal(resistedPull(Number.POSITIVE_INFINITY), 0)
  assert.equal(pullProgress(Number.NaN), 0)
  assert.equal(pulledEnough(Number.NaN), false)
})
