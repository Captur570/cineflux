#!/bin/bash
# Essais dans l'émulateur Android TV (GitHub) : l'appli est lancée écran par écran avec le faux
# fournisseur (ios/ci/mock.py, joignable depuis l'émulateur en 10.0.2.2), captures + journal.
set -u
python3 ios/ci/mock.py > /tmp/mock.log 2>&1 &
sleep 2
OUT=android/ci/out
mkdir -p $OUT
APK=$(ls android/app/build/outputs/apk/release/*.apk | head -1)
adb install -r "$APK" || exit 1
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb logcat -c
adb reverse tcp:8799 tcp:8799
BASE='"server":"127.0.0.1:8799","user":"demo","pass":"demo"'
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
run() {   # run <nom> <attente> <json en plus>
  adb shell am force-stop app.shippotv.android
  local J="{$BASE,\"route\":\"$1\"$3}"
  adb shell am start -n app.shippotv.android/.MainActivity --es test "'$J'" >/dev/null
  sleep "$2"
  shot "$1"
}
run home 40 ""
adb shell input keyevent KEYCODE_DPAD_DOWN; sleep 1; adb shell input keyevent KEYCODE_DPAD_DOWN; sleep 2; shot home_bas
run detail 30 ""
run series 30 ""
run live 30 ""
run player 34 ""
adb shell input keyevent KEYCODE_DPAD_DOWN; sleep 3; shot player_options
adb shell input keyevent KEYCODE_BACK; sleep 1
run live_play 40 ""
run probe 26 ',"probe":"probe/dts_fr.mkv","label":"1080p · VF"'
mv $OUT/probe.png $OUT/probe_dts.png
run probe 26 ',"probe":"probe/hevc10_eac3.mkv","label":"4K HDR · VF"'
mv $OUT/probe.png $OUT/probe_hevc10.png
run probe 26 ',"probe":"probe/aac_en_srtfr.mkv","label":"1080p · VOSTFR"'
mv $OUT/probe.png $OUT/probe_vostfr.png
adb logcat -d -s ShippoTV:V chromium:W > $OUT/journal.txt
adb logcat -d > $OUT/journal-complet.txt
tail -c 300000 $OUT/journal-complet.txt > $OUT/journal-fin.txt; rm $OUT/journal-complet.txt
grep -E "\[lecteur\]|\[box\]" $OUT/journal.txt > $OUT/lecteur.txt || true
exit 0
