import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { Comment } from '../types'
import { blockId, composeReply, hasQuoteLine, splitBlocks } from './blocks'
import { DIVIDER, commentsFromEdit, parseBuffer, renderBuffer } from './buffer'
import { ownText, showPending } from './inline'
import { launchArgv } from './launcher'
import { conflictText, mergeComments, mergeText } from './merge'

type Comments = Record<string, Comment>

// The same refs as inline.tsx's atoms: the validator only reads atoms declared in the file using them.
const comments = atom({ plugin: 'quick-reply', key: 'comments' } as const, {})
const editing = atom({ plugin: 'quick-reply', key: 'editing' } as const, null)
const held = atom({ plugin: 'quick-reply', key: 'held' } as const, '')

// What the buffer shows (shown*) against what the merge starts from (base*).
// They differ only in a reopened buffer, where the conflicts are drawn as markers.
type View = {
  reply: string
  shownComments: Comments
  shownPrompt: string
  baseComments: Comments
  basePrompt: string
  diverged: boolean
  markedIds: readonly string[]
  isPromptMarked: boolean
  wasArmed: boolean
}

const EDITOR = "Use the editor's"
const CURRENT = 'Keep the current one'
const REOPEN = 'Reopen in the editor'

const hasDivider = (text: string) => text.replace(/\r\n/g, '\n').split('\n').includes(DIVIDER)
const trimEnd = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
const same = (a: string | undefined, b: string | undefined) => (a ?? '').trim() === (b ?? '').trim()

async function lastReply($: EngineInterface) {
  const rows = await $.session.messages()

  return [...rows].reverse().find(row => row.role === 'assistant' && row.text !== '')?.text ?? ''
}

// A box that lost the pending comments but still quotes was hand-edited: the box wins, as when sending.
// Without a quote the comments are still pending and the whole box is the prompt.
async function promptParts($: EngineInterface) {
  const box = (await $.prompt.read()).text
  const list = Object.values(await read($, comments))
  const diverged = !box.startsWith(composeReply(list)) && hasQuoteLine(box)

  return { box, own: ownText(box, list), diverged }
}

async function runEditor($: EngineInterface, argv: readonly string[]): Promise<number | null> {
  try {
    const child = $.process.spawn({ argv })
    for await (const _ of child) continue

    return (await child.result).code
  } catch (error) {
    $.ui.toast(`could not start the editor: ${error instanceof Error ? error.message : error}`)

    return null
  }
}

// What the buffer says the comments and the prompt should be, with untouched markers resolved.
function mineFromBuffer(view: View, parsed: { reply: string; prompt: string }) {
  const edited = commentsFromEdit(view.reply, view.shownComments, parsed.reply)
  const mine: Comments = {}
  const ids: string[] = []
  for (const block of splitBlocks(view.reply)) {
    const id = blockId(block)
    if (ids.includes(id)) continue
    ids.push(id)
    let text = edited[id] ?? ''
    // A marker left untouched is no edit: it stands for the current text.
    if (same(text, view.shownComments[id]?.text)) {
      text = (view.markedIds.includes(id) ? view.baseComments[id] : view.shownComments[id])?.text ?? ''
    }
    if (text !== '') mine[id] = { quote: block, text }
  }
  // parseBuffer strips trailing newlines, so compare against the stripped box text.
  const unchanged = parsed.prompt === trimEnd(view.shownPrompt)
  const minePrompt = unchanged ? (view.isPromptMarked ? view.basePrompt : view.shownPrompt) : parsed.prompt

  return { mine, ids, minePrompt }
}

// Writes the buffer, waits for the editor, then applies what changed. Every path
// that applies nothing leaves the file on disk.
async function edit($: EngineInterface, file: string, argv: readonly string[], view: View): Promise<void> {
  const kept = (why: string) => $.ui.toast(`${why}; the buffer is kept at ${file}`)
  const written = renderBuffer(view.reply, view.shownComments, view.shownPrompt)
  await $.fs.write(file, written)
  if ((await runEditor($, argv)) !== 0) return

  const raw = await $.fs.read(file).catch(() => undefined)
  if (raw === undefined) return kept('could not read the buffer')
  const isMarked = view.markedIds.length > 0 || view.isPromptMarked
  if (!isMarked && trimEnd(raw) === trimEnd(written)) return

  const parsed = parseBuffer(raw)
  if (parsed === undefined) return kept('the divider line is missing or repeated, so nothing was applied')
  if (view.reply === '' && parsed.reply.trim() !== '') {
    return kept('there is no reply to comment on, so nothing was applied')
  }

  const { mine, ids, minePrompt } = mineFromBuffer(view, parsed)

  const isArmed = (await read($, editing)) !== null
  const now = await read($, comments)
  const nowParts = isArmed ? undefined : await promptParts($)
  const nowPrompt = nowParts ? nowParts.own : await read($, held)
  // Hand-editing the box while the editor was open makes its comment text part of `own`, so merging would send it twice.
  if (nowParts && nowParts.diverged !== view.diverged) {
    return kept('the prompt or its comments changed while the editor was open, so nothing was applied')
  }
  const merge = view.diverged
    ? { merged: mine, conflicts: [] as string[] }
    : mergeComments(view.baseComments, now, mine, ids)
  // Arming after the snapshot counts as the prompt having changed; a reopen
  // takes a fresh snapshot, so it asks only once.
  const prompt =
    isArmed && !view.wasArmed && trimEnd(minePrompt) !== trimEnd(view.basePrompt)
      ? ({ conflict: true } as const)
      : mergeText(view.basePrompt, nowPrompt, minePrompt)
  const isPromptConflict = 'conflict' in prompt

  let take: readonly string[] = []
  if (merge.conflicts.length > 0 || isPromptConflict) {
    const isCommentConflict = merge.conflicts.length > 0
    const what = isPromptConflict ? (isCommentConflict ? 'The comments and the prompt' : 'The prompt') : 'The comments'
    // The dialog is modal: the box and the comments cannot change while it is open.
    const answer = await $.ui
      .ask(`${what} changed while the editor was open. Which version do you want?`, [EDITOR, CURRENT, REOPEN])
      .catch(() => CURRENT)

    if (answer === REOPEN) {
      const shownComments: Comments = { ...(view.diverged ? mine : merge.merged) }
      for (const id of merge.conflicts) {
        const quote = mine[id]?.quote ?? now[id]?.quote ?? ''
        shownComments[id] = { quote, text: conflictText(mine[id]?.text ?? '', now[id]?.text ?? '') }
      }
      return edit($, file, argv, {
        reply: view.reply,
        shownComments,
        shownPrompt: isPromptConflict ? conflictText(minePrompt, nowPrompt) : prompt.text,
        baseComments: now,
        basePrompt: nowPrompt,
        diverged: view.diverged,
        markedIds: merge.conflicts,
        isPromptMarked: isPromptConflict,
        wasArmed: isArmed,
      })
    }
    if (answer !== EDITOR) return kept('nothing was applied')
    take = merge.conflicts
  }

  await update($, comments, current => {
    const { merged } = view.diverged ? { merged: { ...mine } } : mergeComments(view.baseComments, current, mine, ids)
    for (const id of take) {
      if (mine[id]) merged[id] = mine[id]
      else delete merged[id]
    }

    return merged
  })
  const text = 'conflict' in prompt ? minePrompt : prompt.text
  // While armed the box holds the block's draft, so the prompt only waits in `held`;
  // otherwise showPending reads it from there.
  await update($, held, () => text)
  if (!isArmed) await showPending($)
}

let isOpen = false

// Whether the editor opened; it is left running, not awaited, and frees `isOpen` when it ends.
async function startEditor($: EngineInterface, options: PluginOptions): Promise<boolean> {
  if ((await read($, editing)) !== null) {
    $.ui.toast('finish or cancel the comment you are writing before opening the editor')

    return false
  }
  const reply = await lastReply($)
  const { box, own, diverged } = await promptParts($)
  if (hasDivider(reply) || hasDivider(box)) {
    $.ui.toast('the reply or the prompt contains the buffer divider line, so it cannot be opened')

    return false
  }

  const dir = `${(await $.env.get('XDG_RUNTIME_DIR')) || (await $.env.get('TMPDIR')) || '/tmp'}/quick-reply`
  const file = `${dir}/${await $.session.id()}.md`
  const argv = launchArgv(
    String(options.editorLauncher ?? 'auto'),
    String(options.editorCommand ?? ''),
    {
      TMUX: await $.env.get('TMUX'),
      KITTY_LISTEN_ON: await $.env.get('KITTY_LISTEN_ON'),
      VISUAL: await $.env.get('VISUAL'),
      EDITOR: await $.env.get('EDITOR'),
    },
    file,
  )
  if ('error' in argv) {
    $.ui.toast(argv.error)

    return false
  }

  const now = await read($, comments)
  const shownComments = diverged ? {} : now
  if ((await $.process.run(['mkdir', '-p', '-m', '700', dir])).exitCode !== 0) {
    $.ui.toast(`could not create ${dir}`)

    return false
  }

  edit($, file, argv, {
    reply,
    shownComments,
    shownPrompt: own,
    baseComments: shownComments,
    basePrompt: own,
    diverged,
    markedIds: [],
    isPromptMarked: false,
    wasArmed: false,
  })
    .catch(error => {
      const why = error instanceof Error ? error.message : error
      $.ui.toast(`editing failed: ${why}; the buffer, if written, is at ${file}`)
    })
    .finally(() => {
      isOpen = false
    })

  return true
}

/** Ctrl-X Ctrl-E (bound to `/quick-reply-edit`): the last reply and the prompt in your editor. */
export function registerEditor(on: On, options: PluginOptions) {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.command.register({
      name: 'quick-reply-edit',
      description: "Edit the last reply's comments and the prompt in your editor",
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'quick-reply-edit' }, async ($, _e, _next) => {
    if (isOpen) {
      $.ui.toast('the editor is already open')

      return {}
    }
    // Claimed before the first await: the command is immediate, so a second press can arrive during startup.
    isOpen = true
    let isStarted = false
    try {
      isStarted = await startEditor($, options)
    } finally {
      if (!isStarted) isOpen = false
    }

    return {}
  })
}
