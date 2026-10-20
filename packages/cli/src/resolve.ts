// Project resolution lives in core so the daemon and MCP gateway can share it without a cycle.
export {
  CliError,
  defaultStoreRoot,
  findPointerFile,
  originFingerprint,
  osUser,
  POINTER_PATH,
  type Pointer,
  type ResolvedProject,
  readPointer,
  repoRootOf,
  resolveProject,
} from '@hafiz/core'
