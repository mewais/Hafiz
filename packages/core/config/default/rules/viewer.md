# Hafiz rules — viewer

The read-only session the Kilo TUI panel opens to draw the block tree, review queue and
decisions. This role is never installed as an agent prompt and cannot write: the daemon refuses
every command that would change the store. Changes go through agents or the `hafiz` CLI.
