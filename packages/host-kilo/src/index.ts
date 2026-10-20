// Kilo loads `export default { id, server }` and ignores other exports for such modules.
import type { PluginModule } from './kilo.js'
import { createHafizPlugin } from './plugin.js'

export * from './install.js'
export type * from './kilo.js'
export * from './plugin.js'
export * from './sessions.js'
export * from './shaper/core.js'
export * from './shaper/hooks.js'
export * from './shaper/proxy.js'
export * from './shaper/types.js'
export * from './tools.js'
export * from './wire/anthropic.js'
export * from './wire/openai.js'

export const PACKAGE = '@hafiz/host-kilo'

const plugin: PluginModule = { id: 'hafiz', server: createHafizPlugin() }
export default plugin
