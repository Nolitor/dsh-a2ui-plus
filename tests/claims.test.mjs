/**
 * Tests for the copy-claim registry.
 *
 * The guarantee under test: while the turn-tail copy exists the process row may
 * collapse to a pointer, and the moment that copy goes away the row must report
 * "not claimed" again, so the card is restored instead of disappearing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { client } = await import('../build/shared.mjs')
const { claimCopy, isCopyClaimed, listClaims, resetClaims, subscribeClaims } = client.claims

test('claims are scoped by session and call', () => {
  resetClaims()
  assert.equal(isCopyClaimed('s1', 'c1'), false)
  const release = claimCopy('s1', 'c1')
  assert.equal(isCopyClaimed('s1', 'c1'), true)
  assert.equal(isCopyClaimed('s2', 'c1'), false, 'another session must not see the claim')
  assert.equal(isCopyClaimed('s1', 'c2'), false, 'another call must not see the claim')
  release()
  assert.equal(isCopyClaimed('s1', 'c1'), false)
})

test('releases are idempotent and nested claims count', () => {
  resetClaims()
  const first = claimCopy('s', 'c')
  const second = claimCopy('s', 'c')
  assert.equal(listClaims().length, 2)
  first()
  assert.equal(isCopyClaimed('s', 'c'), true, 'one copy is still mounted')
  first()
  assert.equal(isCopyClaimed('s', 'c'), true, 'a repeated release is ignored')
  second()
  assert.equal(isCopyClaimed('s', 'c'), false)
})

test('missing identifiers never claim', () => {
  resetClaims()
  const release = claimCopy(undefined, 'c')
  assert.equal(isCopyClaimed(undefined, 'c'), false)
  release()
  const empty = claimCopy('s', '')
  assert.equal(isCopyClaimed('s', ''), false)
  empty()
  assert.deepEqual(listClaims(), [])
})

test('subscribers are notified on claim and release, and can unsubscribe', () => {
  resetClaims()
  let calls = 0
  const unsubscribe = subscribeClaims(() => {
    calls += 1
  })
  const release = claimCopy('s', 'c')
  assert.equal(calls, 1)
  release()
  assert.equal(calls, 2)
  unsubscribe()
  claimCopy('s', 'c')()
  assert.equal(calls, 2, 'no notification after unsubscribe')
})

test('a throwing subscriber cannot break the claim', () => {
  resetClaims()
  const unsubscribe = subscribeClaims(() => {
    throw new Error('boom')
  })
  // The claim is recorded and the exception is contained.
  const release = claimCopy('s', 'c')
  assert.equal(isCopyClaimed('s', 'c'), true)
  release()
  assert.equal(isCopyClaimed('s', 'c'), false)
  unsubscribe()
})
