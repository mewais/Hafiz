#!/usr/bin/env node
import { main } from './cli.js'

process.exitCode = await main(process.argv.slice(2), {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
})
