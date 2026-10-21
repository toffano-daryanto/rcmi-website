#!/bin/sh
# Stamp a new version on the site's CSS/JS links so browsers always load matching files.
V=$(date +%s)
sed -i -E "s#(from \"\./[a-z-]+\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" public/js/app.js
sed -i -E "s#(/css/style\.css|/js/app\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" public/index.html
