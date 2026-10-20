#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { run } from './commands.js'

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  entry: fileURLToPath(import.meta.url),
  env: process.env,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
})
