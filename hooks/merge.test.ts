import { expect, test } from 'claude-code/testing'

import { conflictText, mergeComments, mergeText } from './merge'

const c = (text: string) => ({ quote: 'q', text })

test('takes whichever side changed', () => {
  const base = { a: c('x') }
  expect(mergeComments(base, base, { a: c('mine') }, ['a'])).toEqual({ merged: { a: c('mine') }, conflicts: [] })
  expect(mergeComments(base, { a: c('theirs') }, base, ['a'])).toEqual({ merged: { a: c('theirs') }, conflicts: [] })
})

test('accepts the same change made on both sides', () => {
  const r = mergeComments({ a: c('x') }, { a: c('y') }, { a: c('y') }, ['a'])
  expect(r).toEqual({ merged: { a: c('y') }, conflicts: [] })
})

test('reports a conflict and keeps the current comment', () => {
  const r = mergeComments({ a: c('x') }, { a: c('theirs') }, { a: c('mine') }, ['a'])
  expect(r).toEqual({ merged: { a: c('theirs') }, conflicts: ['a'] })
})

test('passes through comments on other replies', () => {
  const r = mergeComments({}, { other: c('click') }, { a: c('mine') }, ['a'])
  expect(Object.keys(r.merged)).toEqual(['other', 'a'])
  expect(r.merged.other).toEqual(c('click'))
  expect(r.conflicts).toEqual([])
})

test('removes a comment deleted in the editor', () => {
  const base = { a: c('x') }
  expect(mergeComments(base, base, {}, ['a'])).toEqual({ merged: {}, conflicts: [] })
})

test('appends new ids in the order of ids', () => {
  const r = mergeComments({}, { z: c('z') }, { b: c('b'), a: c('a') }, ['a', 'b'])
  expect(Object.keys(r.merged)).toEqual(['z', 'a', 'b'])
})

test('mergeText applies the same rule to text', () => {
  expect(mergeText('x', 'x', 'mine')).toEqual({ text: 'mine' })
  expect(mergeText('x', 'theirs', 'x')).toEqual({ text: 'theirs' })
  expect(mergeText('x', 'y', 'y')).toEqual({ text: 'y' })
  expect(mergeText('x', 'theirs', 'mine')).toEqual({ conflict: true })
})

test('conflictText wraps both versions in markers', () => {
  expect(conflictText('m', 'c')).toBe('<<<<<<< editor\nm\n=======\nc\n>>>>>>> current')
})
