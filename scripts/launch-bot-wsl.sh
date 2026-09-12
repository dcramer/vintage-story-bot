#!/usr/bin/env bash
set -euo pipefail

bot_repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bot_game="$bot_repository/.runtime/linux-client"
export DOTNET_ROOT="$bot_repository/.dotnet"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export FONTCONFIG_FILE="$bot_game/fonts.conf"

# Select WSLg's Mesa D3D12 GPU backend; automatic driver selection used
# llvmpipe (CPU rendering) on this host.
unset WAYLAND_DISPLAY
# OpenTK 4.9 only honors its X11 opt-out when the session type is Wayland.
export XDG_SESSION_TYPE=wayland
export OPENTK_4_USE_WAYLAND=0
export GALLIUM_DRIVER=d3d12
export MESA_D3D12_DEFAULT_ADAPTER_NAME="${MESA_D3D12_DEFAULT_ADAPTER_NAME:-NVIDIA}"

if [[ ! -x "$DOTNET_ROOT/dotnet" || ! -f "$bot_game/Vintagestory.dll" ]]; then
    echo "The local Linux client and .NET runtime must be installed first." >&2
    exit 1
fi

# Desktop shortcuts may not inherit the interactive shell's Node PATH.
bot_node="$(command -v node || true)"
if [[ -z "$bot_node" && -x "$HOME/.volta/bin/node" ]]; then
    bot_node="$HOME/.volta/bin/node"
fi
[[ -n "$bot_node" ]] || { echo 'Node 24+ is required.' >&2; exit 1; }
exec "$bot_node" "$bot_repository/scripts/launch-bot.ts" "$bot_game" --wsl "$@"
