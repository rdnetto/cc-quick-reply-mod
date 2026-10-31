# quick-reply

Claude Code mod: reply to specific parts of an agent answer.

Two ways, both ending up in your prompt as `> quote` / comment pairs:

```
> quote 1
my comment 1

> quote 2
my comment 2
```

## Inline comments

1. Hover the left gutter of any block (paragraph, list item, code block) of an
   answer — a `+` appears (over the `●` bullet on a reply's first block). Click it;
   it turns into `▶` and the band above the prompt says which block is armed.
2. Type your comment in the normal prompt — it is mirrored live under the
   block as you type. Press **Shift+Enter** (or **Ctrl+J**) to save: it is
   drawn under the block (`└ comment`, marker `✎`) and the view stays put.
   Plain Enter saves too; outside tmux (see below) Claude Code then scrolls to
   the bottom.
3. Repeat. All pending comments wait in the prompt box (quotes dimmed); press
   Enter to send them, or add your own text below first.

Text already in the prompt (a `>` quote, see below) is set aside while a block
is armed and comes back below the comments once it is saved or cancelled.

Click `✎` to edit a comment, `▶` or **Cancel** to disarm, **Remove** to delete
the armed block's comment, **Clear** in the band to drop them all.

Notes: the plugin draws assistant replies itself (to put markers in the
gutter), so their layout may differ slightly from Claude Code's own. Comments
are tied to a block's text, so identical blocks share one; while a block is
armed a comment can't hold a line break (the newline saves).

### tmux: plain Enter without the jump

Inside tmux this works out of the box. While a block is armed the plugin sets
the pane option `@qr_armed`, and at session start it binds Enter in the running
tmux server (your config files are untouched) to send Shift+Enter while that
flag is set — a save without the scroll:

```
bind-key -T root Enter if-shell -F "#{@qr_armed}" "send-keys S-Enter" "send-keys Enter"
```

At session start (inside tmux only) the plugin also clears a `@qr_armed` left on
its pane by a session that died with a block armed, then decides:

| Your tmux | What the plugin does |
| --- | --- |
| `extended-keys on` (or `always`), Enter unbound | binds Enter as above |
| Enter already bound to this binding | leaves it as is |
| Enter bound by you to something else | leaves yours alone, says so once in the transcript |
| `extended-keys off` | doesn't bind (tmux couldn't send a Shift+Enter Claude Code tells from Enter); says so once, suggesting `set -g extended-keys on` |

Without the binding, Shift+Enter still saves without the jump; plain Enter saves
with it. What each row does to the binding was checked against a real tmux 3.6
server (the transcript notes only show in an interactive session). Turn the
binding off with the plugin's **tmuxEnter** setting (`/config`); the binding
lives in the server's memory, so it is gone after a tmux restart.

Not `C-j`: a bare line feed is inserted by Claude Code without reaching the
plugin.

## Quote a selection

1. Select text in the transcript with the mouse (needs `"tui": "fullscreen"`).
2. On an empty line in the prompt, type `>` — the selection is inserted as a `> ` quote, caret below it.
3. Write your comment; new line with Shift+Enter or `\` + Enter. Repeat, then Enter to send.

`>` on a non-empty line, with nothing selected, or a second time with the same
selection inserts a plain `>`.

## Edit in your editor

`/quick-reply-edit` opens the last reply and your prompt in your editor. Bind
it in `~/.claude/keybindings.json`:

```json
{ "context": "Chat", "bindings": { "ctrl+x ctrl+e": "command:quick-reply-edit" } }
```

In the buffer:

- Every line you add under a block of the reply is a comment on that block,
  with one leading `>` stripped. Comments already pending show up the same way.
  A reworded line counts as an added line; deleted reply text is ignored.
- Everything below the `<!-- quick-reply: everything below this line is your prompt -->`
  line is the prompt box's own text, sent as is.
- Quit without saving (`:cq`) to cancel. If the buffer can't be applied (the
  divider line is gone, say), nothing changes and a toast gives the file's path.
- Comments or prompt text changed while the editor was open are merged. If both
  sides changed the same one, you're asked which version to keep, or to reopen
  the editor with `<<<<<<<` markers around the conflict.

Settings (`/config`): **editorLauncher** is `auto` (tmux popup if you're in
tmux, else a kitty overlay if kitty's remote control is on, else the command),
`tmux`, `kitty` or `command`; **editorCommand** is the command for `command`,
with `{file}` for the buffer's path. It must wait until the editor quits, e.g.
`nvim-qt --nofork {file}`. Terminal editors run as `$VISUAL`, else `$EDITOR`,
else `vi`. The tmux popup needs tmux 3.2 or newer.

## Install

```
/plugin install quick-reply --marketplace ivanzoid/cc-quick-reply-mod
```

Answer `y` to add the marketplace, then pick the user scope.
