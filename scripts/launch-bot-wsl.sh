#!/usr/bin/env bash
set -euo pipefail

bot_repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bot_game="$bot_repository/.runtime/linux-client"
bot_data="$bot_repository/.runtime/bot-data"
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

cd -- "$bot_game"
bot_args=("--dataPath=$bot_data")
case $# in
    0) ;;
    1)
        [[ "$1" != -* && -n "$1" ]] || { echo 'Invalid server address.' >&2; exit 1; }
        bot_args+=("--connect=$1") ;;
    2)
        # The game creates missing worlds; permit only an existing bot save basename.
        [[ "$1" == '--world' && "$2" != */* && "$2" != .* && -f "$bot_data/Saves/$2.vcdbs" ]] || {
            echo 'Expected --world <existing save basename without .vcdbs>.' >&2; exit 1;
        }
        bot_args+=("--openWorld=$2") ;;
    *) echo "Usage: $0 [server-address:port | --world save-basename]" >&2; exit 1 ;;
esac
exec "$DOTNET_ROOT/dotnet" "$bot_game/Vintagestory.dll" "${bot_args[@]}"
