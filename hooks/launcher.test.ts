import { expect, test } from 'claude-code/testing'

import { launchArgv } from './launcher'

const file = '/run/user/1000/quick-reply/s.md'

const argvOf = (...args: Parameters<typeof launchArgv>) => {
  const result = launchArgv(...args)
  if ('error' in result) throw new Error(result.error)

  return result
}

test('auto prefers tmux over kitty when both are set', () => {
  const env = { TMUX: '/tmp/tmux-1000/default,1,0', KITTY_LISTEN_ON: 'unix:/tmp/kitty', EDITOR: 'nvim' }
  expect(launchArgv('auto', '', env, file)).toEqual(
    ['tmux', 'display-popup', '-E', '-w', '90%', '-h', '90%', 'nvim', file],
  )
})

test('auto falls to kitty, targeting its socket', () => {
  expect(launchArgv('auto', '', { KITTY_LISTEN_ON: 'unix:/tmp/kitty', VISUAL: 'vim' }, file)).toEqual([
    'kitty', '@', '--to', 'unix:/tmp/kitty', 'launch', '--type=overlay', '--wait-for-child-to-exit', 'vim', file,
  ])
})

test('auto falls to the command, replacing {file}', () => {
  expect(launchArgv('auto', 'nvim-qt --nofork {file}', {}, file)).toEqual(['nvim-qt', '--nofork', file])
})

test('command without editorCommand is an error naming the setting', () => {
  expect(launchArgv('auto', '  ', {}, file)).toEqual({
    error: 'Set quick-reply editorCommand in /config (e.g. "nvim-qt --nofork {file}")',
  })
})

test('the editor is VISUAL, else EDITOR, else vi, split on whitespace', () => {
  const tmux = { TMUX: 'x' }
  expect(argvOf('tmux', '', { ...tmux, EDITOR: 'nvim -u NONE' }, file).slice(-4)).toEqual(['nvim', '-u', 'NONE', file])
  expect(argvOf('tmux', '', { ...tmux, VISUAL: 'a', EDITOR: 'b' }, file).slice(-2)).toEqual(['a', file])
  expect(argvOf('tmux', '', tmux, file).slice(-2)).toEqual(['vi', file])
})

test('an explicit launcher without its environment is an error naming the variable', () => {
  expect(launchArgv('kitty', '', {}, file)).toEqual({ error: expect.stringContaining('KITTY_LISTEN_ON') })
  expect(launchArgv('tmux', '', {}, file)).toEqual({ error: expect.stringContaining('TMUX') })
})
