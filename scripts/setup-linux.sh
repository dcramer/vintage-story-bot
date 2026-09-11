#!/usr/bin/env bash
# Headless prerequisites without root: Xvfb, xkbcomp and xdotool unpacked into .runtime/x11 when the
# system lacks them (Debian/Ubuntu via apt-get download + dpkg -x). ImageMagick `import` and bubblewrap
# come from the system. Idempotent; prints what is still missing.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
x11="$repo/.runtime/x11"
downloads="$repo/.runtime/downloads"
mkdir -p "$x11" "$downloads"

have() { command -v "$1" >/dev/null 2>&1 || [[ -x "$x11/usr/bin/$1" ]]; }

packages=()
have Xvfb || packages+=(xvfb xserver-common libxfont2 libxcvt0)
have xkbcomp || packages+=(x11-xkb-utils libxkbfile1)
have xdotool || packages+=(xdotool libxdo3)
[[ -d /usr/share/X11/xkb ]] || packages+=(xkb-data)

if (( ${#packages[@]} )); then
    command -v apt-get >/dev/null || { echo "Install xvfb, x11-xkb-utils, xdotool, imagemagick and bubblewrap with your package manager." >&2; exit 1; }
    ( cd "$downloads" && apt-get download "${packages[@]}" )
    for deb in "$downloads"/*.deb; do dpkg -x "$deb" "$x11"; done
fi

# Live view (`pnpm game stream`): ffmpeg encodes the display, mediamtx (single static binary, pinned) serves it.
mediamtx_version="v1.21.0"
tools="$repo/.runtime/tools"
if [[ ! -x "$tools/mediamtx" ]]; then
    mkdir -p "$tools"
    tarball="$downloads/mediamtx_${mediamtx_version}_linux_amd64.tar.gz"
    [[ -f "$tarball" ]] || curl -fsSL -o "$tarball" "https://github.com/bluenviron/mediamtx/releases/download/${mediamtx_version}/mediamtx_${mediamtx_version}_linux_amd64.tar.gz"
    tar -xzf "$tarball" -C "$tools" mediamtx
fi

missing=()
for binary in Xvfb xkbcomp xdotool; do
    have "$binary" || missing+=("$binary")
    [[ -x "$x11/usr/bin/$binary" ]] && LD_LIBRARY_PATH="$x11/usr/lib/x86_64-linux-gnu" ldd "$x11/usr/bin/$binary" | grep -q 'not found' && missing+=("$binary(libs)")
done
command -v import >/dev/null || missing+=("import(imagemagick)")
command -v ffmpeg >/dev/null || missing+=("ffmpeg")
[[ -x "$tools/mediamtx" ]] || missing+=("mediamtx")
if { [[ -e /tmp/.X11-unix && ! -w /tmp/.X11-unix ]] || [[ ! -x /usr/bin/xkbcomp ]]; } && ! command -v bwrap >/dev/null; then
    missing+=("bwrap(bubblewrap)")
fi
if (( ${#missing[@]} )); then
    echo "Missing: ${missing[*]}" >&2
    exit 1
fi
echo "Headless prerequisites ready: Xvfb xkbcomp xdotool import ffmpeg mediamtx$(command -v bwrap >/dev/null && echo ' bwrap')"
