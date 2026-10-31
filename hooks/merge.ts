import type { Comment } from '../types'

type Comments = Readonly<Record<string, Comment>>

/** Three-way merge of the comments for `ids`; the rest of `current` passes through. */
export function mergeComments(
  base: Comments,
  current: Comments,
  mine: Comments,
  ids: readonly string[],
): { merged: Record<string, Comment>; conflicts: string[] } {
  const merged: Record<string, Comment | undefined> = { ...current }
  const conflicts: string[] = []
  for (const id of ids) {
    const [b, c, m] = [base[id]?.text, current[id]?.text, mine[id]?.text]
    if (m === b || m === c) continue
    if (c === b) merged[id] = mine[id]
    else conflicts.push(id)
  }

  const out: Record<string, Comment> = {}
  for (const [id, comment] of Object.entries(merged)) if (comment) out[id] = comment

  return { merged: out, conflicts }
}

export function mergeText(base: string, current: string, mine: string): { text: string } | { conflict: true } {
  if (mine === base || mine === current) return { text: current }
  if (current === base) return { text: mine }

  return { conflict: true }
}

export const conflictText = (mine: string, current: string) =>
  `<<<<<<< editor\n${mine}\n=======\n${current}\n>>>>>>> current`
