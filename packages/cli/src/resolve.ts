// Project resolution lives in core so the daemon and MCP gateway can share it without a cycle.
export {
  CliError,
  defaultStoreRoot,
  findLegacyPointerFile,
  findPointerFile,
  GIT_POINTER_PATH,
  gitCommonDir,
  gitPointerFile,
  originFingerprint,
  osUser,
  POINTER_PATH,
  type Pointer,
  type ResolvedProject,
  readPointer,
  repoRootOf,
  resolveProject,
  worktreeOf,
} from '@hafiz/core'
