# hafiz-context-manager

Hafiz is shared project memory for coding agents. It keeps a tree of blocks (designs, plans,
decisions, progress, threads) outside the conversation and gives every agent a small,
role-shaped view of it, so long sessions and parallel subagents stay consistent. It is served
over MCP and managed with the `hafiz` command.

```sh
npm i -g hafiz-context-manager     # installs the `hafiz` command (Node 22.5 or newer)
hafiz --help
```

One file, no runtime dependencies: the CLI, the per-project daemon and the MCP gateway. Host
integrations are separate packages named `hafiz-<host>` (for example `hafiz-kilo`).

Full documentation: https://github.com/mewais/Hafiz#readme

MIT licensed.
