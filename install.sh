#!/usr/bin/env bash
# Register this checkout as a DSH agent preset by linking it into the user preset
# root. The links point back at this repository, so editing a script here changes
# what the preset runs — no copy step, no stale duplicate.
#
#   ./install.sh            link into ${DSH_HOME:-$HOME/.dsh}/.agent-presets/dsh-steal-code
#   ./install.sh --uninstall remove the links (the checkout is untouched)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET_ROOT="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
TARGET="$PRESET_ROOT/dsh-steal-code"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$TARGET"
  echo "removed $TARGET"
  exit 0
fi

mkdir -p "$TARGET"
ln -sfn "$REPO/agent.cordis.yml" "$TARGET/agent.cordis.yml"
ln -sfn "$REPO/preset.yml" "$TARGET/preset.yml"
ln -sfn "$REPO/plugin.mjs" "$TARGET/plugin.mjs"
ln -sfn "$REPO/reference" "$TARGET/reference"

echo "preset 'dsh-steal-code' registered at $TARGET"
echo "restart dsh, then pick it in the preset picker (it appears as:"
echo "  $(grep -m1 '^name:' "$REPO/preset.yml" | cut -d: -f2- | sed 's/^ //'))"
