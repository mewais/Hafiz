// In-memory backend: reference implementation for the conformance suite and unit tests.
import type { ReadOps, StorageBackend, TxMeta, WriteOps } from './backend.js'
import { cloneState, emptyState, Ops, type State } from './state.js'

export class MemoryBackend implements StorageBackend {
  readonly name = 'memory'
  private state: State = emptyState()
  private queue: Promise<unknown> = Promise.resolve()

  get read(): ReadOps {
    return new Ops(this.state)
  }
  async open() {}
  async close() {}
  async dirty() {
    return []
  }

  /** Serialised; operates on a deep copy and swaps it in on success — all or nothing. */
  tx<T>(meta: TxMeta, fn: (t: WriteOps) => Promise<T>): Promise<{ result: T; commit?: string }> {
    const run = async () => {
      const working = cloneState(this.state)
      const commit = `mem${working.commits + 1}`
      const result = await fn(new Ops(working, meta, commit))
      working.commits++
      this.state = working
      return { result, commit }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }
}
