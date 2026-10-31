import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { blockId } from './blocks'
import { DIVIDER } from './buffer'

const REPLY = 'First para.\n\nSecond para.'
const FILE = '/run/user/1/quick-reply/s1.md'
const ONE = blockId('First para.')
const TWO = blockId('Second para.')

type Row = { role: 'user' | 'assistant'; text: string; toolUses: never[] }
const row = (role: Row['role'], text: string): Row => ({ role, text, toolUses: [] })

const runCommand = ($: Engine) =>
  $.command.run({
    command: 'quick-reply-edit',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

// Stands in for the engine under the plugin: a box, a file system, an editor and a dialog.
function world($: Engine, on: On, opts: { box?: string; messages?: Row[]; code?: number } = {}) {
  const w = {
    box: opts.box ?? 'my draft',
    files: new Map<string, string>(),
    toasts: [] as string[],
    spawns: [] as string[][],
    fills: [] as string[],
    asked: [] as string[],
    answer: 'Use the editor\'s' as string | 'reject',
    // What "the editor" does to the file before it exits.
    editor: async (_text: string): Promise<string | undefined> => undefined,
    code: opts.code ?? 0,
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
    state: new Map<string, unknown>(),
    set: (key: string, value: unknown) => void w.state.set(key, value),
    comments: () => (w.state.get('comments') ?? {}) as Record<string, { quote: string; text: string }>,
    async run() {
      await runCommand($)
      for (let i = 0; i < 30; i++) await w.clock.advance(10)
    },
  }
  w.clock = mock.clock(on)
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1', KITTY_LISTEN_ON: 'unix:/k', EDITOR: 'vim' })
  on('state.get', ($, e) => ({ value: { value: w.state.get(e.key), version: 1 } }))
  on('state.set', ($, e) => {
    w.state.set(e.key, e.value)

    return { value: { isSet: true, version: 1 } }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({
    value: opts.messages ?? [row('user', 'hi'), row('assistant', REPLY), row('assistant', '')],
  }))
  on('prompt.read', () => ({ value: { text: w.box, cursor: w.box.length } }))
  on('prompt.fill', ($, e) => {
    w.box = e.text
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    w.asked.push(e.questions[0]!.question)
    if (w.answer === 'reject') throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: w.answer } } }
  })
  on('process.spawn', async function* ($, e) {
    w.spawns.push([...e.argv])
    const file = e.argv[e.argv.length - 1]!
    const edited = await w.editor(w.files.get(file)!)
    if (edited !== undefined) w.files.set(file, edited)

    return { value: { code: w.code, signal: null } }
  })

  return w
}

const comment = (block: string, text: string) => ({ quote: block, text })
const boxFor = (list: { quote: string; text: string }[], own: string) => {
  const quoted = list.map(c => `${c.quote.split('\n').map(l => `> ${l}`).join('\n')}\n${c.text}`).join('\n\n')

  return quoted + (list.length ? '\n\n' : '') + own
}

test('an added line under a block becomes its comment and lands in the box', async ($, on) => {
  const w = world($, on)
  w.editor = async text => text.replace('Second para.\n', 'Second para.\n> nice\n')
  await w.run()

  expect(w.spawns[0]).toEqual([
    'kitty', '@', '--to', 'unix:/k', 'launch', '--type=overlay', '--wait-for-child-to-exit', 'vim', FILE,
  ])
  expect(w.comments()).toEqual({ [TWO]: comment('Second para.', 'nice') })
  expect(w.box).toBe('> Second para.\nnice\n\nmy draft')
})

test('an unchanged file applies nothing', async ($, on) => {
  const w = world($, on)
  await w.run()

  expect(w.spawns).toHaveLength(1)
  expect(w.fills).toEqual([])
  expect(w.comments()).toEqual({})
})

test('an editor that exits non-zero applies nothing', async ($, on) => {
  const w = world($, on, { code: 1 })
  w.editor = async text => text.replace('Second para.\n', 'Second para.\n> nice\n')
  await w.run()

  expect(w.fills).toEqual([])
  expect(w.comments()).toEqual({})
})

test('a missing divider applies nothing and toasts the path', async ($, on) => {
  const w = world($, on)
  w.editor = async text => text.replace(DIVIDER, '')
  await w.run()

  expect(w.fills).toEqual([])
  expect(w.comments()).toEqual({})
  expect(w.toasts.some(t => t.includes(FILE))).toBe(true)
})

test('a click-flow comment on one block and an editor comment on another both survive', async ($, on) => {
  const w = world($, on)
  w.editor = async text => {
    w.set('comments', { [ONE]: comment('First para.', 'clicked') })
    w.box = boxFor([comment('First para.', 'clicked')], 'my draft')

    return text.replace('Second para.\n', 'Second para.\n> nice\n')
  }
  await w.run()

  expect(w.comments()).toEqual({
    [ONE]: comment('First para.', 'clicked'),
    [TWO]: comment('Second para.', 'nice'),
  })
  expect(w.asked).toEqual([])
  expect(w.box).toBe(
    boxFor([comment('First para.', 'clicked'), comment('Second para.', 'nice')], 'my draft'),
  )
})

for (const [answer, text] of [
  ["Use the editor's", 'mine'],
  ['Keep the current one', 'theirs'],
] as const) {
  test(`the same block changed on both sides asks: ${answer}`, async ($, on) => {
    const w = world($, on)
    w.answer = answer
    w.editor = async file => {
      w.set('comments', { [TWO]: comment('Second para.', 'theirs') })
      w.box = boxFor([comment('Second para.', 'theirs')], 'my draft')

      return file.replace('Second para.\n', 'Second para.\n> mine\n')
    }
    await w.run()

    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).toContain('changed while the editor was open')
    expect(w.comments()[TWO]?.text).toBe(text)
    if (answer !== "Use the editor's") expect(w.toasts.some(t => t.includes(FILE))).toBe(true)
  })
}

test('a dismissed question keeps the current version and toasts the path', async ($, on) => {
  const w = world($, on)
  w.answer = 'reject'
  w.editor = async file => {
    w.set('comments', { [TWO]: comment('Second para.', 'theirs') })
    w.box = boxFor([comment('Second para.', 'theirs')], 'my draft')

    return file.replace('Second para.\n', 'Second para.\n> mine\n')
  }
  await w.run()

  expect(w.comments()[TWO]?.text).toBe('theirs')
  expect(w.toasts.some(t => t.includes(FILE))).toBe(true)
})

test('opening while a block is armed toasts and spawns nothing', async ($, on) => {
  const w = world($, on)
  w.set('editing', { id: ONE, label: 'First para.' })
  await w.run()

  expect(w.spawns).toEqual([])
  expect(w.toasts).toHaveLength(1)
})

test('a pending comment on another reply survives a save', async ($, on) => {
  const w = world($, on, { box: boxFor([comment('Old para.', 'old note')], 'my draft') })
  w.set('comments', { old1: comment('Old para.', 'old note') })
  w.editor = async text => text.replace('Second para.\n', 'Second para.\n> nice\n')
  await w.run()

  expect(w.comments()).toEqual({
    old1: comment('Old para.', 'old note'),
    [TWO]: comment('Second para.', 'nice'),
  })
  expect(w.box).toBe(
    boxFor([comment('Old para.', 'old note'), comment('Second para.', 'nice')], 'my draft'),
  )
})

test('a box without the pending comments or a quote keeps them pending', async ($, on) => {
  const w = world($, on, { box: 'my draft' })
  w.set('comments', { old1: comment('Old para.', 'old note') })
  w.editor = async text => text.replace('Second para.\n', 'Second para.\n> nice\n')
  await w.run()

  expect(w.comments()).toEqual({
    old1: comment('Old para.', 'old note'),
    [TWO]: comment('Second para.', 'nice'),
  })
  expect(w.box).toBe(boxFor([comment('Old para.', 'old note'), comment('Second para.', 'nice')], 'my draft'))
})

test('opening again while the editor is open toasts and leaves the buffer alone', async ($, on) => {
  const w = world($, on)
  let again: Promise<unknown> = Promise.resolve()
  w.editor = async text => {
    again = runCommand($)

    return text.replace('Second para.\n', 'Second para.\n> nice\n')
  }
  await w.run()
  await again

  expect(w.spawns).toHaveLength(1)
  expect(w.toasts.some(t => t.includes('already open'))).toBe(true)
  expect(w.comments()).toEqual({ [TWO]: comment('Second para.', 'nice') })

  w.editor = async () => undefined
  await w.run()
  expect(w.spawns).toHaveLength(2)
})

test('reopening after a save renders the buffer the editor saved', async ($, on) => {
  const w = world($, on)
  w.editor = async text => text.replace('Second para.\n', 'Second para.\n> nice\n> more\n')
  await w.run()
  const saved = w.files.get(FILE)

  w.editor = async () => undefined
  await w.run()

  expect(w.spawns).toHaveLength(2)
  expect(w.files.get(FILE)).toBe(saved)
})

test('text typed above the divider of an empty reply is kept, not applied', async ($, on) => {
  const w = world($, on, { messages: [row('user', 'hi')] })
  w.editor = async text => `stray\n${text}`
  await w.run()

  expect(w.fills).toEqual([])
  expect(w.toasts.some(t => t.includes(FILE))).toBe(true)
})

test('an empty reply still round-trips the prompt', async ($, on) => {
  const w = world($, on, { messages: [row('user', 'hi')] })
  w.editor = async text => text.replace('my draft', 'my edited draft')
  await w.run()

  expect(w.box).toBe('my edited draft')
})

test('a divider already in the box refuses to open', async ($, on) => {
  const w = world($, on, { box: `a\n${DIVIDER}\nb` })
  await w.run()

  expect(w.spawns).toEqual([])
  expect(w.toasts).toHaveLength(1)
})

test('blockquote lines in the reply are not comments, and CRLF is not an edit', async ($, on) => {
  const w = world($, on, { messages: [row('assistant', 'Intro.\n\n> quoted line\n> more')] })
  w.editor = async text => text.replace(/\n/g, '\r\n') + '\r\n'
  await w.run()

  expect(w.fills).toEqual([])
  expect(w.comments()).toEqual({})
})

test('reopening a conflict shows markers, and resolving them applies the result', async ($, on) => {
  const w = world($, on)
  w.answer = 'Reopen in the editor'
  let round = 0
  w.editor = async file => {
    if (round++ > 0) {
      expect(file).toContain('> <<<<<<< editor\n> mine\n> =======\n> theirs\n> >>>>>>> current\n')
      w.answer = "Use the editor's"

      return file.replace(/> <<<<<<< editor\n> mine\n> =======\n> theirs\n> >>>>>>> current\n/, '> resolved\n')
    }
    w.set('comments', { [TWO]: comment('Second para.', 'theirs') })
    w.box = boxFor([comment('Second para.', 'theirs')], 'my draft')

    return file.replace('Second para.\n', 'Second para.\n> mine\n')
  }
  await w.run()

  expect(w.spawns).toHaveLength(2)
  expect(w.comments()[TWO]?.text).toBe('resolved')
  expect(w.box).toBe(boxFor([comment('Second para.', 'resolved')], 'my draft'))
})

test('a reopen after a block was armed meanwhile keeps comments on other replies', async ($, on) => {
  const w = world($, on, { box: boxFor([comment('Old para.', 'old note')], 'my draft') })
  w.set('comments', { old1: comment('Old para.', 'old note') })
  w.answer = 'Reopen in the editor'
  let round = 0
  w.editor = async file => {
    if (round++ > 0) {
      w.answer = "Use the editor's"

      return file.replace(/> <<<<<<< editor\n> mine\n> =======\n> theirs\n> >>>>>>> current\n/, '> resolved\n')
    }
    w.set('editing', { id: ONE, label: 'First para.' })
    w.set('held', 'my draft')
    w.set('comments', { old1: comment('Old para.', 'old note'), [TWO]: comment('Second para.', 'theirs') })
    w.box = 'half-written draft'

    return file.replace('Second para.\n', 'Second para.\n> mine\n')
  }
  await w.run()

  expect(w.comments().old1).toEqual(comment('Old para.', 'old note'))
  expect(w.comments()[TWO]?.text).toBe('resolved')
  expect(w.fills).toEqual([])
})

test('a reopen while armed asks about the prompt only once', async ($, on) => {
  const w = world($, on)
  w.answer = 'Reopen in the editor'
  let round = 0
  w.editor = async file => {
    if (round++ > 0) {
      w.answer = "Use the editor's"

      return file.replace(/<<<<<<< editor\n[\s\S]*>>>>>>> current\n?/, 'resolved prompt\n')
    }
    w.set('editing', { id: ONE, label: 'First para.' })
    w.set('held', 'my draft')
    w.box = 'half-written draft'

    return file.replace('my draft', 'edited prompt')
  }
  await w.run()

  expect(w.asked).toHaveLength(1)
  expect(w.state.get('held')).toBe('resolved prompt')
})

test('a box hand-edited while the editor was open applies nothing', async ($, on) => {
  const w = world($, on, { box: boxFor([comment('Old para.', 'old note')], 'my draft') })
  w.set('comments', { old1: comment('Old para.', 'old note') })
  w.editor = async text => {
    w.box = '> Old para.\nrewritten by hand'

    return text.replace('Second para.\n', 'Second para.\n> nice\n')
  }
  await w.run()

  expect(w.fills).toEqual([])
  expect(w.box).toBe('> Old para.\nrewritten by hand')
  expect(w.toasts.some(t => t.includes(FILE))).toBe(true)
})

test('a trailing newline in the box is not a prompt conflict', async ($, on) => {
  const w = world($, on, { box: 'my draft\n' })
  w.editor = async text => {
    w.box = 'my draft\nmore'

    return text.replace('Second para.\n', 'Second para.\n> nice\n')
  }
  await w.run()

  expect(w.asked).toEqual([])
  expect(w.comments()).toEqual({ [TWO]: comment('Second para.', 'nice') })
})
