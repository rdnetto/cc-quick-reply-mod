import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { Armed, Comment } from '../types'
import { blockId, composeReply, sendText, splitBlocks } from './blocks'
import { quoteDecorations } from './quote'
import { isQuoteTrigger, resetLastQuoted, withQuote } from './quote-trigger'
import { ARMED_OPTION, ENTER_BINDING, tmuxPlan } from './tmux'

const comments = atom({ plugin: 'quick-reply', key: 'comments' } as const, {})
// The block armed for a comment: the next prompt typed is saved as its comment
// instead of being sent. (A field inside a transcript row never gets the keys.)
const editing = atom({ plugin: 'quick-reply', key: 'editing' } as const, null)
// The prompt's text while a block is armed, drawn live under that block.
const draft = atom({ plugin: 'quick-reply', key: 'draft' } as const, '')
// The prompt's own text (a `>` quote, a reply begun) set aside while a block is
// armed, put back below the pending comments once it is saved or cancelled.
const held = atom({ plugin: 'quick-reply', key: 'held' } as const, '')

/** Mirrors the prompt under the armed block as it is typed; no-op otherwise. */
async function mirrorDraft($: EngineInterface, text: string) {
  if ((await read($, editing)) === null) return
  await update($, draft, () => text)
}

// Saves `text` as the armed block's comment (empty removes it) and disarms.
async function saveArmed($: EngineInterface, armed: Armed, quote: string | undefined, text: string) {
  await update($, comments, cur => {
    const { [armed.id]: _, ...rest } = cur
    const q = quote ?? cur[armed.id]?.quote

    return text === '' || q === undefined ? rest : { ...rest, [armed.id]: { quote: q, text } }
  })
  await disarm($)
}

// Mirrors "a block is armed" into the tmux pane option @qr_armed, so the tmux
// binding (setUpTmux) turns Enter into Shift+Enter then: a save without
// Enter's submit, which scrolls the transcript to its end. Outside tmux, or
// failing, nothing happens.
async function setTmuxArmed($: EngineInterface, isArmed: boolean) {
  const pane = await $.env.get('TMUX_PANE')
  if (pane === undefined || pane === '') return
  const argv = isArmed
    ? ['tmux', 'set-option', '-p', '-t', pane, ARMED_OPTION, '1']
    : ['tmux', 'set-option', '-p', '-u', '-t', pane, ARMED_OPTION]
  await $.process.run(argv, { timeoutMs: 2000 }).catch(() => undefined)
}

// At session start inside tmux: clear a flag a crashed session left on this
// pane, then (option tmuxEnter) bind Enter in the running server, never over
// the person's own Enter binding nor without extended keys. The config files
// are untouched; the binding lasts until the server ends.
async function setUpTmux($: EngineInterface, isEnterWanted: boolean) {
  const pane = await $.env.get('TMUX_PANE')
  if (pane === undefined || pane === '') return
  await setTmuxArmed($, false)
  if (!isEnterWanted) return

  const run = (argv: readonly string[]) =>
    $.process.run(['tmux', ...argv], { timeoutMs: 2000 }).catch(() => undefined)
  const keys = await run(['show-options', '-sv', 'extended-keys'])
  const bound = await run(['list-keys', '-T', 'root', 'Enter'])
  const plan = tmuxPlan(keys?.stdout ?? '', bound?.exitCode === 0 ? bound.stdout : '')

  if (plan === 'bind') await run(ENTER_BINDING)
  if (plan === 'no-extended-keys') {
    $.ui.log('quick-reply: tmux extended-keys is off, so Enter saving a comment scrolls to the end; `set -g extended-keys on` fixes it')
  }
  if (plan === 'enter-taken') {
    $.ui.log('quick-reply: tmux Enter is already bound, left as is; Shift+Enter saves a comment without scrolling')
  }
}

const disarm = async ($: EngineInterface) => {
  await update($, editing, () => null)
  await update($, draft, () => '')
  await setTmuxArmed($, false)
}

const firstLine = (text: string, max = 50) => {
  const line = (text.split('\n')[0] ?? '').replace(/^[-*+#>\s]+|^\d+[.)]\s+/, '')

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// Puts the pending comments in the prompt box, ready to send with Enter, and
// below them the text set aside when the block was armed (or the caret's line).
async function showPending($: EngineInterface) {
  const text = pendingText(Object.values(await read($, comments))) + (await read($, held))
  await update($, held, () => '')
  await $.prompt.fill({ text, decorations: quoteDecorations(text) })
}

// The pending comments as the prompt box holds them, the caret's line below.
const pendingText = (list: Comment[]) => (list.length === 0 ? '' : `${composeReply(list)}\n\n`)

/** The box's text other than the pending comments showPending put at its head. */
export function ownText(box: string, list: Comment[]): string {
  const reply = list.length === 0 ? '' : composeReply(list)

  return reply !== '' && box.startsWith(reply) ? box.slice(reply.length).replace(/^\n+/, '') : box
}

/**
 * Inline comments: a marker beside each block of a reply arms it, the next
 * prompt typed is saved as its comment, and the comments wait in the prompt.
 * Also the `>` selection quote, which shares the prompt hooks.
 */
export function registerInlineComments(on: On, options: PluginOptions) {
  on('session.start', async ($, e, next) => {
    await setUpTmux($, options.tmuxEnter !== false)

    return next(e)
  })

  // Quotes by block id, for blocks drawn this session: the armed id's quote
  // is read from here when the comment is saved.
  const quotes = new Map<string, string>()

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const blocks = splitBlocks(e.props.text)
    if (blocks.length === 0) return next(e)

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const all = await read($, comments)
    const armed = await read($, editing)
    const typed = await read($, draft)

    return (
      <Box flexDirection="column">
        {blocks.map((block, i) => {
          const id = blockId(block)
          quotes.set(id, block)
          const comment = all[id]
          const isArmed = armed?.id === id
          const isBullet = i === 0 && e.props.isFirstOfReply
          const marker = isArmed ? '▶' : comment ? '✎' : null
          const markerButton = (label: string) => (
            <Button
              key={`c:${id}`}
              label={label}
              plain
              dimColor={label === '+'}
              onPress={async () => {
                if (isArmed) {
                  await disarm($)
                  await showPending($)
                  return
                }
                // Arming over another armed block drops that one's draft only.
                if ((await read($, editing)) === null) {
                  const box = (await $.prompt.read()).text
                  const list = Object.values(await read($, comments))
                  await update($, held, () => ownText(box, list))
                }
                await update($, editing, () => ({ id, label: firstLine(block) }))
                await setTmuxArmed($, true)
                await update($, draft, () => comment?.text ?? '')
                await $.prompt.fill({ text: comment?.text ?? '' })
              }}
            />
          )

          return (
            <Box key={`b:${id}`} flexDirection="column" marginBottom={i < blocks.length - 1 ? 1 : 0}>
              <Box flexDirection="row">
                <Box key={`g:${id}`} width={2} flexShrink={0}>
                  {/* ✎ and ▶ show always. Otherwise a `+` is laid over the gutter
                      (absolute, so it covers a reply's ● bullet) and revealed only
                      while the pointer is over the gutter, its own hover scope. */}
                  {marker === null ? (
                    <>
                      <Text>{isBullet ? '●' : ' '}</Text>
                      <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }}>
                        {markerButton('+')}
                      </Box>
                    </>
                  ) : (
                    markerButton(marker)
                  )}
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Markdown text={block} />
                </Box>
              </Box>
              {isArmed ? (
                <Box marginLeft={2}>
                  {typed.trim() === '' ? (
                    <Text dimColor italic>└ type your comment in the prompt; Shift+Enter or Ctrl+J saves</Text>
                  ) : (
                    <Text color="warning" italic>{`└ ${typed}▏`}</Text>
                  )}
                </Box>
              ) : (
                comment && (
                  <Box marginLeft={2}>
                    <Text color="warning">{`└ ${comment.text}`}</Text>
                  </Box>
                )
              )}
            </Box>
          )
        })}
      </Box>
    )
  })

  // The plugin's one prompt.edit hook: a `>` on an empty line quotes the
  // mouse selection; while a block is armed the draft is mirrored under it and
  // a newline (Shift+Enter, Ctrl+J) saves it: an edit, unlike
  // Enter's submit, leaves the transcript where it is. Quote lines draw dim.
  on('prompt.edit', async ($, e, next) => {
    const armed = await read($, editing)
    const isNewline =
      e.inputText !== '' && e.inputText.trim() === '' && /[\r\n]/.test(e.inputText)
    if (armed && isNewline) {
      await saveArmed($, armed, quotes.get(armed.id), e.text.trim())
      // A box answered here with the comments in it did not show them until
      // Enter (seen live); consume the key with an empty box, then fill it.
      $.clock.after(50, () => void showPending($))

      return { text: '', cursor: 0 }
    }

    const edit = isQuoteTrigger(e) ? withQuote(e, (await $.ui.selection())?.text) : e
    const r = await next(edit)
    await mirrorDraft($, r.text)

    return { ...r, decorations: [...(r.decorations ?? []), ...quoteDecorations(r.text)] }
  })

  on('prompt.submit', async ($, e, next) => {
    resetLastQuoted()
    if (e.origin?.kind !== 'composer' || e.text.trimStart().startsWith('/')) return next(e)

    const armed = await read($, editing)
    if (!armed) {
      const list: Comment[] = Object.values(await read($, comments))
      if (list.length === 0) return next(e)
      await update($, comments, () => ({}))
      // The box usually holds them already (showPending); else they go first.
      return next({ ...e, text: sendText(e.text.trim(), list) })
    }

    await saveArmed($, armed, quotes.get(armed.id), e.text.trim())
    // The engine empties the box once the drop is answered; refill after it.
    // (Enter also scrolls the transcript to its end, which no hook can undo.)
    $.clock.after(50, () => void showPending($))

    return { drop: `comment saved on «${armed.label}» (not sent)` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, comments)
    const list: Comment[] = Object.values(all)
    const armed = await read($, editing)
    if (e.props.hasSurvey || (list.length === 0 && !armed)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    // Drops the comments, keeping the box's own text (set aside, if armed).
    const clear = async () => {
      const own = armed ? await read($, held) : ownText((await $.prompt.read()).text, list)
      await update($, comments, () => ({}))
      await disarm($)
      await update($, held, () => '')
      await $.prompt.fill({ text: own, decorations: quoteDecorations(own) })
    }

    return (
      <Box flexDirection="column">
        {armed && (
          <Box flexDirection="row" gap={1}>
            <Text color="warning">{`✎ commenting on «${armed.label}» — type it, Shift+Enter or Ctrl+J saves`}</Text>
            {all[armed.id] && (
              <Button
                key="remove"
                label="Remove"
                onPress={async () => {
                  await update($, comments, ({ [armed.id]: _, ...rest }) => rest)
                  await disarm($)
                  await showPending($)
                }}
              />
            )}
            <Button
              key="cancel"
              label="Cancel"
              onPress={async () => {
                await disarm($)
                await showPending($)
              }}
            />
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Text color="warning">{`${list.length} comment${list.length === 1 ? '' : 's'} · in the prompt, Enter sends`}</Text>
            <Button
              key="clear"
              label="Clear"
              onPress={async () => {
                await clear()
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
