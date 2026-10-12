#!/usr/bin/env bash
# Builds android/build/EngShorts.apk with the plain Android SDK tools (no Gradle).
# Runs on GitHub Actions (see .github/workflows/android.yml).
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$SDK" ] || { echo "ANDROID_HOME is not set"; exit 1; }
BT_VER="${BUILD_TOOLS:-35.0.0}"
API="${PLATFORM_API:-35}"
BT="$SDK/build-tools/$BT_VER"
[ -d "$BT" ] || BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/android-$API/android.jar"
[ -f "$JAR" ] || JAR="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
echo "build-tools: $BT"
echo "android.jar: $JAR"

VCODE="${VERSION_CODE:-1}"
VNAME="${VERSION_NAME:-1.0.$VCODE}"
KS_PASS="${KS_PASS:-engshorts}"

OUT=build
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/assets/www"
cp ../index.html "$OUT/assets/www/index.html"

echo "== resources"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" \
  --manifest AndroidManifest.xml -R "$OUT/res.zip" -A "$OUT/assets" \
  --java "$OUT/gen" --auto-add-overlay \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VCODE" --version-name "$VNAME"

echo "== java"
javac -encoding UTF-8 --release 8 -Xlint:-options \
  -classpath "$JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')

echo "== dex"
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

echo "== package"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -u ../unsigned.apk classes.dex)
"$BT/zipalign" -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks keystore/eng-shorts.jks --ks-key-alias engshorts \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$OUT/EngShorts.apk" "$OUT/aligned.apk"

echo "== verify"
"$BT/apksigner" verify --verbose "$OUT/EngShorts.apk" | head -8
"$BT/aapt2" dump badging "$OUT/EngShorts.apk" | head -12
ls -la "$OUT/EngShorts.apk"
