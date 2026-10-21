#!/bin/sh
# Installs the t3mini binary from GitHub releases:
#   curl -fsSL https://raw.githubusercontent.com/edwinencomienda/t3mini/main/install.sh | sh
#   … | sh -s -- v0.1.0      a specific version (default: the latest)
# It picks the binary for this machine (macOS or Linux, arm64 or x64), checks it against the
# release's SHA256SUMS, and puts it in ~/.local/bin (or $T3_MINI_BIN_DIR).
set -eu

repo="edwinencomienda/t3mini"
version="${1:-latest}"
bin_dir="${T3_MINI_BIN_DIR:-$HOME/.local/bin}"

fail() {
  echo "t3mini install: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported processor $(uname -m)" ;;
esac
asset="t3mini-$os-$arch"

case "$version" in
  latest) base="https://github.com/$repo/releases/latest/download" ;;
  v[0-9]*) base="https://github.com/$repo/releases/download/$version" ;;
  *) fail "versions look like v0.1.0" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required to check the download"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

echo "Downloading $asset ($version)…"
curl -fsSL --proto '=https' --tlsv1.2 -o "$work/$asset" "$base/$asset" ||
  fail "couldn't download $base/$asset"
curl -fsSL --proto '=https' --tlsv1.2 -o "$work/SHA256SUMS" "$base/SHA256SUMS" ||
  fail "couldn't download the checksums"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")"
[ -n "$expected" ] || fail "no checksum for $asset in this release"
[ "$(sum "$work/$asset")" = "$expected" ] || fail "checksum mismatch: not installing it"

mkdir -p "$bin_dir"
chmod 755 "$work/$asset"
# Moved into place in one step, so a running t3mini keeps its file until it restarts.
mv "$work/$asset" "$bin_dir/.t3mini.new"
mv "$bin_dir/.t3mini.new" "$bin_dir/t3mini"

echo "Installed $("$bin_dir/t3mini" version 2>/dev/null || echo t3mini) → $bin_dir/t3mini"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add it to your PATH (e.g. in ~/.zshrc or ~/.bashrc): export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo "Next: t3mini start   (then t3mini pair to add this machine from another computer)"
echo "Claude Code and/or Codex need to be installed and signed in on this machine."
