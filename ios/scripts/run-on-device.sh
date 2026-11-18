#!/usr/bin/env bash
# Build, install and launch the t3 mini app on a connected iPhone.
# Usage: scripts/run-on-device.sh [part of the device name]
#   e.g. scripts/run-on-device.sh            # the only / first connected iPhone
#        scripts/run-on-device.sh "Pro Max"  # pick one when several are connected
# One-time setup (signing, Developer Mode) is in ios/README.md.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

if [ ! -f Config/Signing.xcconfig ]; then
  echo "Copy Config/Signing.example.xcconfig to Config/Signing.xcconfig and fill in your team and bundle id." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

xcrun devicectl list devices --json-output "$tmp/devices.json" >/dev/null 2>&1 || {
  echo "Couldn't list devices (is Xcode installed?)." >&2; exit 1; }

# Prints "<coredevice-id>\t<udid>\t<name>" for the chosen iPhone, or explains what's wrong.
device="$(python3 -I - "$tmp/devices.json" "${1:-}" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
query = sys.argv[2].lower()
phones = []
for d in devices:
    hw, props, conn = d.get("hardwareProperties", {}), d.get("deviceProperties", {}), d.get("connectionProperties", {})
    if hw.get("platform") != "iOS" or hw.get("reality") != "physical":
        continue
    if query and query not in props.get("name", "").lower():
        continue
    phones.append((d, hw, props, conn))
if not phones:
    sys.exit("No matching iPhone found. Plug it in, unlock it, and tap Trust on the phone.")
reachable = [p for p in phones if p[3].get("tunnelState") == "connected"]
d, hw, props, conn = (reachable or phones)[0]
if conn.get("pairingState") != "paired":
    sys.exit(f"{props.get('name')} isn't paired. Unlock it and tap Trust This Computer.")
if not reachable:
    # Known but not reachable right now ("unavailable" in `xcrun devicectl list devices`): the
    # build would fail later with "Unable to find a destination", which says nothing useful.
    sys.exit(f"{props.get('name')} isn't reachable right now. Unlock it and keep it plugged in (or awake on the same Wi-Fi), then run this again.")
if props.get("developerModeStatus") != "enabled":
    sys.exit(f"Developer Mode is off on {props.get('name')}: Settings → Privacy & Security → Developer Mode → On, restart, tap Turn On.")
print(f"{d['identifier']}\t{hw['udid']}\t{props.get('name')}")
PY
)"
IFS=$'\t' read -r core_id udid name <<<"$device"
echo "▸ Device: $name"

echo "▸ Generating project"
xcodegen generate >/dev/null

echo "▸ Building (registers the device and updates signing if needed)"
if ! xcodebuild -project T3Mini.xcodeproj -scheme T3Mini \
  -destination "platform=iOS,id=$udid" -derivedDataPath build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  build >"$tmp/build.log" 2>&1; then
  grep -E "error:" "$tmp/build.log" | sort -u >&2 || tail -20 "$tmp/build.log" >&2
  echo "Build failed. See ios/README.md → Run on your iPhone." >&2
  exit 1
fi

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' build/Build/Products/Debug-iphoneos/T3Mini.app/Info.plist)"

echo "▸ Installing"
xcrun devicectl device install app --device "$core_id" build/Build/Products/Debug-iphoneos/T3Mini.app >/dev/null

echo "▸ Launching"
xcrun devicectl device process launch --device "$core_id" "$bundle_id" >/dev/null
echo "✓ t3 mini is running on $name"
