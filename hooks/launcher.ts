export type LauncherEnv = { TMUX?: string; KITTY_LISTEN_ON?: string; VISUAL?: string; EDITOR?: string }

const words = (s: string) => s.split(/\s+/).filter(Boolean)

/** The command that opens `file` in an editor and blocks until it quits, or why there isn't one. */
export function launchArgv(
  launcher: string,
  editorCommand: string,
  env: LauncherEnv,
  file: string,
): readonly string[] | { error: string } {
  const kind = launcher === 'auto' ? (env.TMUX ? 'tmux' : env.KITTY_LISTEN_ON ? 'kitty' : 'command') : launcher
  const editor = words(env.VISUAL || env.EDITOR || 'vi')

  if (kind === 'tmux') {
    if (!env.TMUX) return { error: 'quick-reply editorLauncher is tmux, but TMUX is not set: pick another in /config' }

    return ['tmux', 'display-popup', '-E', '-w', '90%', '-h', '90%', ...editor, file]
  }
  if (kind === 'kitty') {
    if (!env.KITTY_LISTEN_ON) {
      return { error: 'quick-reply editorLauncher is kitty, but KITTY_LISTEN_ON is not set: pick another in /config' }
    }

    return ['kitty', '@', '--to', env.KITTY_LISTEN_ON, 'launch', '--type=overlay', '--wait-for-child-to-exit', ...editor, file]
  }
  const argv = words(editorCommand)
  if (argv.length === 0) return { error: 'Set quick-reply editorCommand in /config (e.g. "nvim-qt --nofork {file}")' }

  return argv.map(a => (a === '{file}' ? file : a))
}
