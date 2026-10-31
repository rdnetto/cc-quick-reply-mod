import type { Comment } from '../types'

const ITEM = /^(?:[-*+] |\d+[.)] |#{1,6} |> )/

/**
 * Splits a reply's markdown into the blocks a comment can attach to:
 * paragraphs, top-level list items, headings, and fenced code blocks whole.
 */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | undefined
  const flush = () => {
    if (current.length > 0) blocks.push(current.join('\n'))
    current = []
  }

  for (const line of markdown.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (fence !== undefined) {
      current.push(line)
      if (marker !== undefined && marker.startsWith(fence)) {
        fence = undefined
        flush()
      }
      continue
    }
    if (marker !== undefined) {
      flush()
      fence = marker
      current.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    if (ITEM.test(line)) flush()
    current.push(line)
  }
  flush()

  return blocks
}

/** The prompt the comments make: each quoted block, its comment under it. */
export function composeReply(comments: readonly Comment[]): string {
  return comments
    .map(({ quote, text }) => {
      const quoted = quote
        .split('\n')
        .map(line => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
        .join('\n')

      return `${quoted}\n${text}`
    })
    .join('\n\n')
}

/** What a composer submit sends: the box as is, else the comments first. */
export function sendText(box: string, list: readonly Comment[]): string {
  const reply = composeReply(list)
  // A hand-edited comment still holds a quote; prepending would send it twice.
  if (box.startsWith(reply) || box.split('\n').some(line => line.startsWith('>'))) return box

  return box === '' ? reply : `${reply}\n\n${box}`
}

/**
 * A block's id: a hash of its text. The engine may draw a reply again under
 * another requestId, so ids made from it would orphan the comments made.
 */
export function blockId(block: string): string {
  let h = 5381
  for (let i = 0; i < block.length; i++) h = ((h * 33) ^ block.charCodeAt(i)) >>> 0

  return `${h.toString(36)}${block.length.toString(36)}`
}
