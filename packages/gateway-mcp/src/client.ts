// The daemon client alone (no MCP server, no storage backends): for processes that only talk to
// a running daemon, such as the Kilo TUI panel.
export * from './daemon/client.js'
export * from './daemon/paths.js'
export * from './daemon/rpc.js'
export type { QueuedNotice } from './daemon/service.js'
