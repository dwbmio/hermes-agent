import { expect, it } from 'vitest'

import { $rExtPolicy, enableBundledPolicy } from './r-ext-policy'

it('can enable, remove and replace the actual bundled Rust policy', () => {
  expect($rExtPolicy.get()).toBeUndefined()
  const remove = enableBundledPolicy()
  const first = $rExtPolicy.get()!
  expect(first({ op: 'intake', action: false })).toBe(3)
  expect(first({ op: 'intake', action: true, clear: true, suitable: true, authorized: true })).toBe(1)
  expect(first({ op: 'identity', value: ' a' })).toBe(0)
  expect(first({ op: 'identity', value: 'x'.repeat(262_145) })).toBe(0)
  const removeReplacement = enableBundledPolicy()
  remove()
  expect($rExtPolicy.get()).not.toBe(first)
  removeReplacement()
  expect($rExtPolicy.get()).toBeUndefined()
})
