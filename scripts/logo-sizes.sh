#!/bin/sh
# Renders the shipped ICO frames (16, 32, 48 px) at actual size on a dark and a light background, and enlarged 8x
# (nearest neighbour) for inspection. Output: docs/screenshots/logo-small-sizes.png. Needs ImageMagick.
set -e
ICO=assets/brand/GitManager-Summa.ico
OUT=docs/screenshots/logo-small-sizes.png
T=$(mktemp -d)
for i in 0 2 3; do convert "$ICO[$i]" -background '#e8e8e8' -flatten -filter point -resize 800% -bordercolor '#e8e8e8' -border 12 "$T/z$i.png"; done
convert -background '#e8e8e8' -gravity center "$T/z0.png" "$T/z2.png" "$T/z3.png" +append "$T/zoom.png"
for bg in 202020 f3f3f3; do
  convert -size 200x64 "xc:#$bg" "$ICO[0]" -geometry +24+24 -composite "$ICO[2]" -geometry +64+16 -composite "$ICO[3]" -geometry +120+8 -composite "$T/a$bg.png"
done
convert "$T/a202020.png" "$T/af3f3f3.png" +append "$T/actual.png"
convert "$T/zoom.png" "$T/actual.png" -background white -gravity west -append "$OUT"
rm -r "$T"
echo "wrote $OUT"
