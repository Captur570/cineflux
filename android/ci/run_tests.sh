#!/bin/bash
# Essais dans l'émulateur Android TV (GitHub) : l'appli est lancée écran par écran avec le faux
# fournisseur (ios/ci/mock.py, joignable depuis l'émulateur en 10.0.2.2), captures + journal.
set -u
MOCK_POSTERS=24 python3 ios/ci/mock.py > /tmp/mock.log 2>&1 &
sleep 2
OUT=android/ci/out
mkdir -p $OUT
APK=$(ls android/app/build/outputs/apk/release/*.apk | head -1)
adb install -r "$APK" || exit 1
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb logcat -c
adb reverse tcp:8799 tcp:8799
BASE='"server":"127.0.0.1:8799","user":"demo","pass":"demo","tmdb":"testkey","tmdb_api":"http://127.0.0.1:8799/3"'
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
run probe 13 ',"probe":"probe/dts_fr.mkv","label":"1080p · VF"'
mv $OUT/probe.png $OUT/probe_dts.png
run probe 13 ',"probe":"probe/hevc10_eac3.mkv","label":"4K HDR · VF"'
mv $OUT/probe.png $OUT/probe_hevc10.png
run probe 13 ',"probe":"probe/aac_en_srtfr.mkv","label":"1080p · VOSTFR"'
mv $OUT/probe.png $OUT/probe_vostfr.png
# ---- visite de l'appli (captures pour l'utilisateur)
js() {   # js <nom> <attente> <code JS> [touches...]
  local n=$1 w=$2 c=$(printf '%s' "$3" | base64 -w0); shift 3
  run js "$w" ",\"js64\":\"$c\""
  rm -f $OUT/js.png
  for k in "$@"; do if [ "$k" = "_" ]; then sleep 2; else adb shell input keyevent $k; sleep 0.6; fi; done
  sleep 2; shot "visite_$n"
}
adb shell pm clear app.shippotv.android >/dev/null
run setup 25 ""; mv $OUT/setup.png $OUT/visite_01_premier_lancement.png
for i in 1 2 3 4 5 6; do adb shell input keyevent KEYCODE_DPAD_DOWN; sleep 0.5; done; sleep 2; shot visite_02_premier_lancement_code
js 03_accueil_bas 25 "scrollTo(0, 1100)"
js 04_accueil_plus_bas 25 "scrollTo(0, 2300)"
js 05_films 25 "go('movies')"
js 06_films_categories 25 "go('movies')" KEYCODE_DPAD_DOWN KEYCODE_DPAD_DOWN KEYCODE_DPAD_RIGHT KEYCODE_DPAD_RIGHT
js 07_films_bas 25 "go('movies'); setTimeout(() => scrollTo(0, 1000), 1500)"
js 08_series 25 "go('series')"
js 09_fiche_serie 25 "openDetail('series', S.cat.series[0])"
js 10_fiche_serie_episodes 25 "openDetail('series', S.cat.series[0]); setTimeout(() => scrollTo(0, 700), 3000)"
js 11_fiche_film 25 "openDetail('movie', S.cat.movies.find(m => /dune/i.test(m.t)) || S.cat.movies[0])"
js 12_direct_guide 25 "S.liveTab = 'guide'; go('live')"
js 13_direct_chaines 25 "S.liveTab = 'chaines'; go('live')"
js 14_recherche 25 "go('search', { q: 'du' })"
js 15_ma_liste 25 "go('mylist')"
js 16_profils 25 "go('profiles')"
js 17_reglages 25 "go('settings')"
js 18_reglages_synchro 25 "go('settings'); setTimeout(() => { const s = document.querySelector('#sync-set'); s && s.scrollIntoView({ block: 'center' }); }, 3000)"
js 19_reglages_bas 25 "go('settings'); setTimeout(() => scrollTo(0, 99999), 3000)"
js 20_lecture_bandeau 22 "playMovie(S.cat.movies[1])"
js 21_lecture_infos 28 "playMovie(S.cat.movies[1])" KEYCODE_DPAD_RIGHT
js 22_direct_lecture 28 "playLive(S.cat.live[2], 0)"
js 23_direct_zapping 28 "playLive(S.cat.live[2], 0)" KEYCODE_DPAD_UP _
adb logcat -d -s ShippoTV:V chromium:W > $OUT/journal.txt
adb logcat -d > $OUT/journal-complet.txt
tail -c 300000 $OUT/journal-complet.txt > $OUT/journal-fin.txt; rm $OUT/journal-complet.txt
grep -E "\[lecteur\]|\[box\]" $OUT/journal.txt > $OUT/lecteur.txt || true
exit 0
