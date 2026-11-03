#!/bin/sh
# Fonts for the virtual member card (Noto, SIL Open Font License). Fetched at build time, not committed.
set -e
d="$(dirname "$0")/../assets"; mkdir -p "$d"
base=https://github.com/notofonts/notofonts.github.io/raw/main/fonts
curl -fsSL -o "$d/NotoSerif-Bold.ttf" "$base/NotoSerif/hinted/ttf/NotoSerif-Bold.ttf"
curl -fsSL -o "$d/NotoSans-Regular.ttf" "$base/NotoSans/hinted/ttf/NotoSans-Regular.ttf"
ls -la "$d"
