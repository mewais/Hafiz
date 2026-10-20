import { conformance } from './conformance.js'
import { MemoryBackend } from './memory.js'

conformance('memory', async () => {
  const b = new MemoryBackend()
  await b.open()
  return b
})
