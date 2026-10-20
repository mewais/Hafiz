#!/usr/bin/env bash
# Release the two publishable packages: hafiz-context-manager (packages/hafiz), then hafiz-kilo
# (packages/kilo-plugin), which depends on the core's exact version.
#   scripts/publish.sh          dry run: build, test, `npm pack --dry-run`, `pnpm publish --dry-run`
#   scripts/publish.sh --yes    really publish (needs `npm login`; add --otp <code> if 2FA asks)
# Uses `pnpm publish` because it rewrites the plugin's `workspace:^0.1.0` dependency to the real
# version in the tarball (npm publish would not). Refuses on a dirty tree.
set -euo pipefail
cd "$(dirname "$0")/.."

yes=0
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) yes=1 ;;
    --dry-run) yes=0 ;;
    *) extra+=("$1") ;;
  esac
  shift
done

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to release: working tree is not clean" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test

pkgs=(packages/hafiz packages/kilo-plugin)
for p in "${pkgs[@]}"; do
  (cd "$p" && npm pack --dry-run)
done

flags=(--access public --no-git-checks)
if [ "$yes" -eq 0 ]; then
  flags+=(--dry-run)
  echo "dry run (pass --yes to publish)"
fi
for p in "${pkgs[@]}"; do
  (cd "$p" && pnpm publish "${flags[@]}" ${extra[@]+"${extra[@]}"})
done
