#!/bin/sh
# タイマーの小窓（iPhone 用）に使う動画 media/timer.mp4 を作る。
#
# iPhone の Safari は「その場で描いた映像（canvas.captureStream）」を小窓にできない。
# そこで、0:00 から 10 時間ぶん、1秒ごとに数字が進む動画を前もって作っておき、
# 再生位置をタイマーの秒数に合わせて小窓に出す（src/pip-timer.js）。
#
# 1秒1コマ・320x180 なので 10 時間でも 5MB ほど。ffmpeg（libx264）が要る。
#   sh tools/build-timer-video.sh
set -eu
FONT=${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf}
OUT=${OUT:-media/timer.mp4}
MMSS="%{eif\:mod(trunc(t/60),60)\:d\:2}\:%{eif\:mod(trunc(t),60)\:d\:2}"
HMMSS="%{eif\:trunc(t/3600)\:d}\:${MMSS}"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x0b0b0d:s=320x180:r=1:d=36000" \
  -vf "drawtext=fontfile=${FONT}:fontsize=84:fontcolor=0xfafafa:x=(w-tw)/2:y=(h-th)/2:text='${MMSS}':enable='lt(t,3600)',drawtext=fontfile=${FONT}:fontsize=62:fontcolor=0xfafafa:x=(w-tw)/2:y=(h-th)/2:text='${HMMSS}':enable='gte(t,3600)'" \
  -c:v libx264 -preset veryslow -tune stillimage -crf 30 -g 600 -pix_fmt yuv420p \
  -movflags +faststart "${OUT}"
