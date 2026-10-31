import type { Register } from 'claude-code'

import { registerEditor } from './editor'
import { registerInlineComments } from './inline'

export const register: Register = (on, options) => {
  registerInlineComments(on, options)
  registerEditor(on, options)
}
