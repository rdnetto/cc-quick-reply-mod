import { expect, test } from 'claude-code/testing'

import { blockId, splitBlocks } from './blocks'
import { DIVIDER, commentsFromEdit, parseBuffer, renderBuffer } from './buffer'

const reply = 'A para.\n\n- item\n\n> quoted\n\n```\ncode\n```'
const blocks = splitBlocks(reply)
const ids = blocks.map(blockId)

test('round-trips comments and the prompt through the buffer', () => {
  const comments = {
    [ids[0]!]: { quote: blocks[0]!, text: 'first\n\nsecond' },
    [ids[2]!]: { quote: blocks[2]!, text: 'on the quote' },
  }
  const buf = renderBuffer(reply, comments, 'my prompt')
  const p = parseBuffer(buf)!
  expect(p.prompt).toBe('my prompt')
  expect(commentsFromEdit(reply, comments, p.reply)).toEqual({
    [ids[0]!]: 'first\n\nsecond',
    [ids[1]!]: '',
    [ids[2]!]: 'on the quote',
    [ids[3]!]: '',
  })
})

test('renders a comment right after its block, ending in one newline', () => {
  const buf = renderBuffer('a\n\nb', { [blockId('a')]: { quote: 'a', text: 'c' } }, 'p')
  expect(buf).toBe(`a\n> c\n\nb\n\n${DIVIDER}\np\n`)
})

test('does not read a reply blockquote as a comment', () => {
  const p = parseBuffer(renderBuffer(reply, {}, ''))!
  expect(Object.values(commentsFromEdit(reply, {}, p.reply))).toEqual(['', '', '', ''])
})

const para = 'l1\nl2\nl3'

test('takes a line added inside a block as its comment', () => {
  expect(commentsFromEdit(para, {}, 'l1\nl2\nnote\nl3')).toEqual({ [blockId(para)]: 'note' })
})

test('takes a line added above the first block as its comment', () => {
  expect(commentsFromEdit(`${para}\n\nz`, {}, `top\n${para}\n\nz`)[blockId(para)]).toBe('top')
})

test('joins several added lines', () => {
  expect(commentsFromEdit(para, {}, 'l1\na\nl2\nl3\nb')).toEqual({ [blockId(para)]: 'a\nb' })
})

test('strips the quote marker from added lines', () => {
  expect(commentsFromEdit('p', {}, 'p\n> x')).toEqual({ [blockId('p')]: 'x' })
  expect(commentsFromEdit('p', {}, 'p\n>x')).toEqual({ [blockId('p')]: 'x' })
})

test('reads a rewritten line as a comment', () => {
  expect(commentsFromEdit('old words', {}, 'new words')).toEqual({ [blockId('old words')]: 'new words' })
})

const roundTrip = (r: string, comments: Record<string, string>) => {
  const full = Object.fromEntries(
    Object.entries(comments).map(([quote, text]) => [blockId(quote), { quote, text }]),
  )
  const result = commentsFromEdit(r, full, parseBuffer(renderBuffer(r, full, ''))!.reply)
  return Object.fromEntries(Object.entries(result).filter(([, text]) => text !== ''))
}

test('round-trips a comment equal to the next blockquote line', () => {
  expect(roundTrip('x\n> q', { x: 'q' })).toEqual({ [blockId('x')]: 'q' })
  expect(roundTrip('x\n> q', { '> q': 'q' })).toEqual({ [blockId('> q')]: 'q' })
})

test('round-trips a comment that repeats the block line, in order', () => {
  expect(roundTrip('> b', { '> b': 'more\nb' })).toEqual({ [blockId('> b')]: 'more\nb' })
})

test('keeps a comment on its block when a later block repeats its text', () => {
  expect(roundTrip('x\n\n> q', { x: 'q' })).toEqual({ [blockId('x')]: 'q' })
})

test('keeps a new comment on a block whose text repeats', () => {
  const r = 'ok\n\nother\n\nok'
  expect(commentsFromEdit(r, {}, 'ok\n> note\n\nother\n\nok')[blockId('ok')]).toBe('note')
})

test('keeps an edit to a repeated block\'s comment', () => {
  const r = 'ok\n\nother\n\nok'
  const comments = { [blockId('ok')]: { quote: 'ok', text: 'c' } }
  expect(commentsFromEdit(r, comments, 'ok\n> d\n\nother\n\nok')[blockId('ok')]).toBe('d')
})

test('drops a deleted comment line and keeps an edited one', () => {
  const r = 'a\n\nb'
  const comments = { [blockId('a')]: { quote: 'a', text: 'one\ntwo' } }
  expect(commentsFromEdit(r, comments, 'a\n> one\n\nb')).toEqual({ [blockId('a')]: 'one', [blockId('b')]: '' })
  expect(commentsFromEdit(r, comments, 'a\n> one\n> 2\n\nb')[blockId('a')]).toBe('one\n2')
})

test('round-trips a CRLF reply with the ids of the raw reply', () => {
  const crlf = 'A para.\r\n\r\n- item\r\n\r\n> quoted\r\n\r\n```\r\ncode\r\n```'
  const rawIds = splitBlocks(crlf).map(blockId)
  const comments = { [rawIds[0]!]: { quote: '', text: 'one' }, [rawIds[3]!]: { quote: '', text: 'two' } }
  const buf = renderBuffer(crlf, comments, 'p')
  expect(buf).not.toContain('\r')
  expect(commentsFromEdit(crlf, comments, parseBuffer(buf)!.reply)).toEqual({
    [rawIds[0]!]: 'one',
    [rawIds[1]!]: '',
    [rawIds[2]!]: '',
    [rawIds[3]!]: 'two',
  })
})

test('attaches a gap addition to the previous block', () => {
  expect(commentsFromEdit('a\n\nb', {}, 'a\n\nnote\nb')).toEqual({ [blockId('a')]: 'note', [blockId('b')]: '' })
})

test('ignores CRLF and a trailing newline from the editor', () => {
  const buf = renderBuffer(reply, {}, 'p')
  expect(parseBuffer(`${buf}\n`)).toEqual(parseBuffer(buf))
  expect(parseBuffer(buf.replace(/\n/g, '\r\n'))).toEqual(parseBuffer(buf))
})

test('rejects a buffer with no divider or more than one', () => {
  expect(parseBuffer('just text\n')).toBe(undefined)
  expect(parseBuffer(`a\n${DIVIDER}\nb\n${DIVIDER}\n`)).toBe(undefined)
})

test('round-trips the prompt of an empty reply', () => {
  expect(parseBuffer(renderBuffer('', {}, 'p'))).toEqual({ reply: '', prompt: 'p' })
  expect(commentsFromEdit('', {}, '')).toEqual({})
})
