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
    # libnettle's package name differs between releases; other unresolved libraries are reported below.
    if LD_LIBRARY_PATH="$x11/usr/lib/x86_64-linux-gnu" ldd "$x11/usr/bin/Xvfb" 2>/dev/null | grep -q 'libnettle.*not found'; then
        nettle=libnettle8t64; apt-cache policy "$nettle" 2>/dev/null | grep -q Candidate || nettle=libnettle8
        ( cd "$downloads" && apt-get download "$nettle" ) && dpkg -x "$downloads"/libnettle*.deb "$x11"
    fi
fi

missing=()
for binary in Xvfb xkbcomp xdotool; do
    have "$binary" || missing+=("$binary")
    [[ -x "$x11/usr/bin/$binary" ]] && LD_LIBRARY_PATH="$x11/usr/lib/x86_64-linux-gnu" ldd "$x11/usr/bin/$binary" | grep -q 'not found' && missing+=("$binary(libs)")
done
command -v import >/dev/null || missing+=("import(imagemagick)")
if { [[ -e /tmp/.X11-unix && ! -w /tmp/.X11-unix ]] || [[ ! -x /usr/bin/xkbcomp ]]; } && ! command -v bwrap >/dev/null; then
    missing+=("bwrap(bubblewrap)")
fi
if (( ${#missing[@]} )); then
    echo "Missing: ${missing[*]}" >&2
    exit 1
fi
echo "Headless prerequisites ready: $(have Xvfb && echo Xvfb) $(have xkbcomp && echo xkbcomp) $(have xdotool && echo xdotool) import$(command -v bwrap >/dev/null && echo ' bwrap')"
