#!/usr/bin/env bash
# Sign (and optionally notarize) Smriti.app, then build the DMG.
#
#   macos_sign.sh --adhoc                 # no certificate: ad-hoc signature
#   macos_sign.sh --developer-id          # sign + notarize + staple + DMG
#
# We deliberately do NOT let tauri sign: its macOS path uses `codesign --deep`,
# which Apple deprecates for distribution. --deep applies ONE entitlements set
# to every nested binary in unspecified order and is known to miss .so files in
# non-standard locations. The interpreter needs different entitlements from the
# shell, so we sign explicitly, inner to outer.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI="$HERE/../src-tauri"
TARGET="${TARGET:-aarch64-apple-darwin}"
APP="${APP:-$TAURI/target/$TARGET/release/bundle/macos/Smriti.app}"
VERSION="$(grep -m1 '^version' "$TAURI/Cargo.toml" | cut -d'"' -f2)"
OUT="${OUT:-$TAURI/target/$TARGET/release/bundle/dmg}"

MODE="${1:---adhoc}"
case "$MODE" in
  --adhoc)        IDENTITY="-" ;;
  --developer-id) IDENTITY="${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}" ;;
  *) echo "usage: $0 [--adhoc|--developer-id]" >&2; exit 2 ;;
esac

[ -d "$APP" ] || { echo "no bundle at $APP — run tauri build first" >&2; exit 1; }
echo "==> signing $APP"
echo "    identity: $IDENTITY"

# Stray extended attributes (com.apple.provenance, quarantine) break signing.
xattr -cr "$APP"

# Hardened runtime only makes sense with a real identity; an ad-hoc signature
# plus --options runtime is not a combination Gatekeeper ever evaluates.
# (macOS ships bash 3.2, where "${arr[@]}" on an empty array trips `set -u`,
#  so branch in a function instead of splatting an array.)
sign_file() {
  if [ "$IDENTITY" = "-" ]; then
    codesign --force --sign - "$1"
  else
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$1"
  fi
}

# --- 1. every nested Mach-O, deepest first -----------------------------------
# Enumerate by CONTENT, not extension: an extension-based find WILL miss
# something in a tree this size, and one missed binary is an opaque
# "code signature invalid" crash at runtime.
echo "==> enumerating nested Mach-O binaries…"
MACHOS="$(mktemp)"
find "$APP/Contents/Resources" -type f -perm +111 -o -type f -name '*.so' -o -type f -name '*.dylib' \
  | while read -r f; do
      file -b "$f" 2>/dev/null | grep -q 'Mach-O' && echo "$f" || true
    done \
  | awk '{ print gsub("/","/"), $0 }' | sort -rn | cut -d' ' -f2- > "$MACHOS"
COUNT=$(wc -l < "$MACHOS" | tr -d ' ')
echo "    $COUNT binaries"

n=0
while read -r f; do
  sign_file "$f" 2>/dev/null || { echo "    FAILED: $f" >&2; exit 1; }
  n=$((n+1))
  if [ $((n % 50)) -eq 0 ]; then echo "    …$n/$COUNT"; fi
done < "$MACHOS"
rm -f "$MACHOS"

# --- 2. the interpreter, with its own entitlements ----------------------------
PY="$APP/Contents/Resources/runtime/bin/python3.12"
ENT_PY="$TAURI/entitlements.python.plist"
echo "==> signing interpreter with library-validation exemption"
if [ "$IDENTITY" != "-" ]; then
  codesign --force --options runtime --timestamp \
    --entitlements "$ENT_PY" --sign "$IDENTITY" "$PY"
else
  codesign --force --sign "$IDENTITY" "$PY"
fi

# --- 3. the bundle LAST, no --deep -------------------------------------------
echo "==> signing the bundle"
if [ "$IDENTITY" != "-" ]; then
  codesign --force --options runtime --timestamp \
    --entitlements "$TAURI/entitlements.plist" --sign "$IDENTITY" "$APP"
else
  codesign --force --sign "$IDENTITY" "$APP"
fi

echo "==> verifying"
codesign --verify --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

ARCH="${TARGET%%-*}"
mkdir -p "$OUT"
ZIP="$OUT/Smriti-$VERSION-$ARCH.zip"
DMG="$OUT/Smriti-$VERSION-$ARCH.dmg"

# --- 4. notarize the app (Developer ID only) ---------------------------------
# Must happen BEFORE packaging so the stapled ticket ends up inside both
# artifacts — notarizing a DMG that contains an unstapled app is a common
# mistake that still shows a warning on first launch.
if [ "$IDENTITY" != "-" ]; then
  echo "==> notarizing the app"
  NZIP="$(mktemp -d)/Smriti.zip"
  ditto -c -k --keepParent "$APP" "$NZIP"
  xcrun notarytool submit "$NZIP" --keychain-profile "${NOTARY_PROFILE:-SMRITI_NOTARY}" --wait
  xcrun stapler staple "$APP"
fi

# --- 4b. regenerate the updater payload from the SIGNED app ------------------
# `tauri build` writes Smriti.app.tar.gz BEFORE this script signs anything, so
# that tarball contains an unsigned bundle — which on Apple Silicon would not
# even execute after the updater installed it. Rebuild it from the app as it
# now stands, and re-sign with the updater key.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "==> rebuilding the updater payload from the signed app"
  APPDIR="$(dirname "$APP")"
  UPD="$APPDIR/Smriti.app.tar.gz"
  rm -f "$UPD" "$UPD.sig"
  # -C so the archive contains "Smriti.app" at its root, as the updater expects
  tar -czf "$UPD" -C "$APPDIR" "$(basename "$APP")"
  ( cd "$TAURI" && npx --yes @tauri-apps/cli@2 signer sign "$UPD" >/dev/null )
  [ -f "$UPD.sig" ] || { echo "    updater signing produced no .sig" >&2; exit 1; }
  echo "    $(basename "$UPD") ($(du -h "$UPD" | cut -f1)) + .sig"
else
  echo "==> no TAURI_SIGNING_PRIVATE_KEY — skipping updater payload"
  echo "    (in-app updates will not be offered for this build)"
fi

# --- 5. package: zip for the cask, DMG for direct download -------------------
# Both are produced regardless of signing mode — the free/ad-hoc path needs a
# shippable artifact just as much as the paid one.
echo "==> packaging"
rm -f "$ZIP" "$DMG"
ditto -c -k --keepParent "$APP" "$ZIP"

STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Smriti.app"
ln -s /Applications "$STAGE/Applications"   # the drag-to-install target
# ULFO (lzfse) compresses better and faster than UDZO, and is fine on macOS 14+
hdiutil create -volname Smriti -srcfolder "$STAGE" -ov -format ULFO "$DMG" >/dev/null
rm -rf "$STAGE"

if [ "$IDENTITY" != "-" ]; then
  echo "==> notarizing the DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "${NOTARY_PROFILE:-SMRITI_NOTARY}" --wait
  xcrun stapler staple "$DMG"
fi

# --- 6. report ---------------------------------------------------------------
echo
echo "  artifacts:"
for f in "$ZIP" "$DMG"; do
  printf "    %-42s %6s  sha256 %s\n" \
    "$(basename "$f")" \
    "$(du -h "$f" | cut -f1)" \
    "$(shasum -a 256 "$f" | cut -c1-16)…"
done
echo
echo "  full checksums (for the cask / release notes):"
for f in "$ZIP" "$DMG"; do
  echo "    $(shasum -a 256 "$f" | cut -d' ' -f1)  $(basename "$f")"
done

if [ "$IDENTITY" = "-" ]; then
  cat <<'EOF'

  NOT NOTARIZED. Ad-hoc signing is required on Apple Silicon (unsigned arm64
  binaries will not execute at all) but it is not a distribution signature.

  macOS 15+ removed the right-click -> Open bypass, and Homebrew removed
  --no-quarantine, so a plain download means the user must go:
      launch -> blocked -> System Settings -> Privacy & Security -> "Open Anyway"

  The cask works around this with a postflight that strips the quarantine
  attribute after install. Notarizing (Apple Developer ID, $99/yr) is the only
  way to remove the step entirely.
EOF
fi
