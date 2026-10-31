import type { Comment } from '../types'
import { blockId, splitBlocks } from './blocks'

export const DIVIDER = '<!-- quick-reply: everything below this line is your prompt -->'

const lf = (text: string) => text.replace(/\r\n/g, '\n')

/** For each block, the lines it spans (inclusive), found in order in `lines`. */
function spans(lines: readonly string[], blocks: readonly string[]): [number, number][] {
  const found: [number, number][] = []
  let from = 0
  for (const block of blocks) {
    const part = block.split('\n')
    let start = from
    while (start < lines.length && !part.every((line, i) => lines[start + i] === line)) start++
    if (start >= lines.length) throw new Error('block not found in reply lines')
    found.push([start, start + part.length - 1])
    from = start + part.length
  }

  return found
}

const quoteLines = (text: string) => text.split('\n').map(line => (line === '' ? '>' : `> ${line}`))

/** The reply (as LF lines) with each block's comment as `> ` lines under it, then the prompt. */
export function renderBuffer(
  reply: string,
  comments: Readonly<Record<string, Comment>>,
  prompt: string,
): string {
  const lines = lf(reply).split('\n')
  const ids = splitBlocks(reply).map(blockId)
  const after = new Map<number, string[]>()
  spans(lines, splitBlocks(lf(reply))).forEach(([, end], i) => {
    const comment = comments[ids[i]!]
    // Copies of a block share one id, so only the first carries the comment.
    if (comment === undefined || ids.indexOf(ids[i]!) !== i) return
    after.set(end, quoteLines(comment.text))
  })
  const body = reply === '' ? [] : lines.flatMap((line, i) => [line, ...(after.get(i) ?? [])])
  const out = [...body, '', DIVIDER]
  if (prompt !== '') out.push(prompt)

  return `${out.join('\n')}\n`
}

/** Splits a saved buffer at its divider; undefined unless there is exactly one. */
export function parseBuffer(text: string): { reply: string; prompt: string } | undefined {
  const lines = lf(text).replace(/\n+$/, '').split('\n')
  const at = lines.indexOf(DIVIDER)
  if (at < 0 || lines.indexOf(DIVIDER, at + 1) >= 0) return undefined
  const head = lines.slice(0, at)
  if (head[head.length - 1] === '') head.pop()

  return { reply: head.join('\n'), prompt: lines.slice(at + 1).join('\n') }
}

/**
 * The text of each reply block's comment, from an edit of the buffer as `renderBuffer` shows it:
 * the comment lines kept plus the lines added. Keys use the reply as given (not LF-normalised)
 * so they match the ids of the click flow.
 */
export function commentsFromEdit(
  reply: string,
  comments: Readonly<Record<string, Comment>>,
  edited: string,
): Record<string, string> {
  const lines = lf(reply).split('\n')
  const blocks = splitBlocks(lf(reply))
  const ids = splitBlocks(reply).map(blockId)
  const result: Record<string, string> = {}
  if (blocks.length === 0) return result

  const base: { line: string; owner: number; comment: boolean }[] = []
  const found = spans(lines, blocks)
  const ownerOf = (i: number) => Math.max(0, found.filter(([start]) => start <= i).length - 1)
  lines.forEach((line, i) => {
    const owner = ownerOf(i)
    base.push({ line, owner, comment: false })
    if (found[owner]![1] !== i) return
    const comment = comments[ids[owner]!]
    if (comment === undefined || ids.indexOf(ids[owner]!) !== owner) return
    for (const text of quoteLines(comment.text)) base.push({ line: text, owner, comment: true })
  })

  const a = base.map(entry => entry.line)
  const b = lf(edited).split('\n')
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const text = blocks.map((): string[] => [])
  let i = 0
  let j = 0
  let owner = 0
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      owner = base[i]!.owner
      if (base[i]!.comment) text[owner]!.push(b[j]!.replace(/^> ?/, ''))
      i++
      j++
    } else if (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      owner = base[i++]!.owner
    } else {
      text[owner]!.push(b[j]!.replace(/^> ?/, ''))
      j++
    }
  }
  const joined: Record<string, string[]> = {}
  ids.forEach((id, n) => (joined[id] ??= []).push(...text[n]!))
  for (const [id, commentLines] of Object.entries(joined)) result[id] = commentLines.join('\n').trim()

  return result
}
