#!/bin/sh
# Gives the site's CSS/JS files a new ?v= number so browsers load the new version instead of an old cached copy.
cd "$(dirname "$0")/.." || exit 1
v=$(date +%s)
sed -i -E "s/\?v=[0-9]+/?v=$v/g" public/index.html public/js/*.js
echo "version $v"
