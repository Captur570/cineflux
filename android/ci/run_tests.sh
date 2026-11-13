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
adb shell "echo 1 > /data/local/tmp/shippotv-essais; chmod 644 /data/local/tmp/shippotv-essais"
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
# ---- visite de l'appli en UNE seule session : la page enchaîne les écrans toutes les 5 s
# et le signale dans le journal ; la capture est prise 3,5 s après chaque signal.
js() {   # js <nom> <attente> <code JS> [touches...]
  local n=$1 w=$2 c=$(printf '%s' "$3" | base64 -w0); shift 3
  run js "$w" ",\"js64\":\"$c\""
  rm -f $OUT/js.png
  for k in "$@"; do if [ "$k" = "_" ]; then sleep 2; else adb shell input keyevent $k; sleep 0.7; fi; done
  sleep 1.5; shot "visite_$n"
}
STEPS='[
 ["03_accueil_bas", "go(\"home\"); setTimeout(() => scrollTo(0, 1100), 800)"],
 ["04_accueil_plus_bas", "scrollTo(0, 2300)"],
 ["05_films", "go(\"movies\")"],
 ["07_films_bas", "scrollTo(0, 1000)"],
 ["08_series", "go(\"series\")"],
 ["09_fiche_serie", "openDetail(\"series\", S.cat.series[0])"],
 ["10_fiche_serie_episodes", "scrollTo(0, 700)"],
 ["11_fiche_film", "openDetail(\"movie\", S.cat.movies[0])"],
 ["12_direct_a_la_une", "S.liveTab = \"une\"; go(\"live\")"],
 ["13_direct_guide", "S.liveTab = \"guide\"; go(\"live\")"],
 ["14_direct_chaines", "S.liveTab = \"chaines\"; go(\"live\")"],
 ["15_recherche", "go(\"search\", { q: (S.cat.series[0] || {}).t || \"Film\" })"],
 ["16_ma_liste", "go(\"mylist\")"],
 ["17_reglages", "go(\"settings\")"],
 ["18_reglages_synchro", "const s = document.querySelector(\"#sync-set\"); s && s.scrollIntoView({ block: \"center\" })"],
 ["19_reglages_bas", "scrollTo(0, 99999)"],
 ["20_profils", "go(\"profiles\")"]
]'
SEQ="const L = $STEPS; L.forEach((s, i) => setTimeout(() => { console.warn('[essai] etape ' + i); try { (0, eval)(s[1]); } catch (e) { console.error('[essai] ' + e); } }, i * 5000));"
adb logcat -c
run js 1 ",\"js64\":\"$(printf '%s' "$SEQ" | base64 -w0)\""; rm -f $OUT/js.png
for i in $(seq 1 60); do adb logcat -d | grep -q "\[essai\] etape 0" && break; sleep 1; done
T0=$(date +%s.%N)
NAMES=$(python3 -c "import json,sys; print(' '.join(s[0] for s in json.loads(sys.argv[1])))" "$STEPS")
i=0; for n in $NAMES; do
  python3 -c "import time; t=$T0+$i*5+3.5-time.time(); time.sleep(max(0,t))"
  shot "visite_$n"; i=$((i+1))
done
# films : se déplacer dans les catégories à la télécommande
js 06_films_categories 22 "go('movies')" KEYCODE_DPAD_DOWN KEYCODE_DPAD_DOWN KEYCODE_DPAD_RIGHT KEYCODE_DPAD_RIGHT
# premier lancement (appli remise à zéro)
adb shell pm clear app.shippotv.android >/dev/null
adb shell "echo 1 > /data/local/tmp/shippotv-essais; chmod 644 /data/local/tmp/shippotv-essais"
run setup 20 ""; mv $OUT/setup.png $OUT/visite_01_premier_lancement.png
for i in 1 2 3 4 5 6; do adb shell input keyevent KEYCODE_DPAD_DOWN; sleep 0.4; done; sleep 1.5; shot visite_02_premier_lancement_code
# ---- lecteur : barre de commandes, avance rapide, langues et sous-titres
run player 14 ""; mv $OUT/player.png $OUT/lecteur_01_lecture.png
adb shell input keyevent KEYCODE_DPAD_CENTER; sleep 1.5; shot lecteur_02_pause_commandes
adb shell input keyevent KEYCODE_DPAD_CENTER; sleep 1; adb shell input keyevent KEYCODE_BACK; sleep 1
adb shell input keyevent KEYCODE_DPAD_RIGHT; sleep 0.3; adb shell input keyevent KEYCODE_DPAD_RIGHT; sleep 0.3; adb shell input keyevent KEYCODE_DPAD_RIGHT; sleep 0.3; shot lecteur_03_avance_rapide
sleep 2; adb shell input keyevent KEYCODE_BACK; sleep 0.6; adb shell input keyevent KEYCODE_DPAD_DOWN; sleep 1; shot lecteur_04_commandes_langue
adb shell input keyevent KEYCODE_DPAD_CENTER; sleep 1.2; shot lecteur_05_panneau_langue
adb shell input keyevent KEYCODE_BACK; sleep 0.6; adb shell input keyevent KEYCODE_DPAD_RIGHT; sleep 0.5; adb shell input keyevent KEYCODE_DPAD_CENTER; sleep 1.2; shot lecteur_06_panneau_sous_titres
adb shell input keyevent KEYCODE_BACK; sleep 0.6
for k in 1 2 3 4; do adb shell input keyevent KEYCODE_DPAD_RIGHT; sleep 0.4; done; adb shell input keyevent KEYCODE_DPAD_CENTER; sleep 1.2; shot lecteur_07_panneau_lecteur
adb shell input keyevent KEYCODE_BACK; sleep 0.5; adb shell input keyevent KEYCODE_BACK; sleep 0.5; adb shell input keyevent KEYCODE_BACK; sleep 1
run probe 4 ',"probe":"probe/aac_en_srtfr.mkv","label":"1080p · VOSTFR"'; rm -f $OUT/probe.png
adb shell input keyevent KEYCODE_DPAD_DOWN; sleep 0.6; adb shell input keyevent KEYCODE_DPAD_RIGHT; sleep 0.5; adb shell input keyevent KEYCODE_DPAD_CENTER; sleep 1.2; shot lecteur_08_sous_titres_vostfr
js 21_direct_commandes 24 "playLive(S.cat.live[1], 0)" KEYCODE_DPAD_CENTER
adb logcat -d -s ShippoTV:V chromium:W > $OUT/journal.txt
adb logcat -d > $OUT/journal-complet.txt
tail -c 300000 $OUT/journal-complet.txt > $OUT/journal-fin.txt; rm $OUT/journal-complet.txt
grep -E "\[lecteur\]|\[box\]" $OUT/journal.txt > $OUT/lecteur.txt || true
exit 0
