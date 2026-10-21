#!/bin/sh
# Installs the t3mini binary from GitHub releases:
#   curl -fsSL https://raw.githubusercontent.com/edwinencomienda/t3mini/main/install.sh | sh
#   … | sh -s -- v0.1.1      a specific version (default: the latest)
# It picks the binary for this machine (macOS or Linux, arm64 or x64), checks it against the
# release's SHA256SUMS, and puts it in ~/.local/bin (or $T3_MINI_BIN_DIR).
set -eu

repo="edwinencomienda/t3mini"
requested="${1:-latest}"
bin_dir="${T3_MINI_BIN_DIR:-$HOME/.local/bin}"

# Colors and the progress bar only in a terminal (stderr: stdout is the pipe from curl), and
# never with NO_COLOR.
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  bold="$(printf '\033[1m')" dim="$(printf '\033[2m')" reset="$(printf '\033[0m')"
  green="$(printf '\033[32m')" red="$(printf '\033[31m')" cyan="$(printf '\033[36m')"
  yellow="$(printf '\033[33m')"
  tty=1
else
  bold="" dim="" reset="" green="" red="" cyan="" yellow=""
  tty=""
fi
say() { printf '%s\n' "$*" >&2; }
step() { say "  ${green}✓${reset} $*"; }
note() { say "  ${dim}$*${reset}"; }
fail() {
  say "  ${red}✗ $*${reset}"
  exit 1
}

say ""
say "  ${bold}t3mini${reset} ${dim}· Claude Code and Codex threads, in one quiet place${reset}"
say ""

case "$(uname -s)" in
  Darwin) os=darwin os_name=macOS ;;
  Linux) os=linux os_name=Linux ;;
  *) fail "Unsupported system: $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "Unsupported processor: $(uname -m)" ;;
esac
asset="t3mini-$os-$arch"
step "Platform     ${bold}$os_name $arch${reset}"

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required to check the download"
fi
fetch() { curl -fsSL --proto '=https' --tlsv1.2 "$@"; }

# The version: the one asked for, or where /releases/latest redirects (no API rate limit).
case "$requested" in
  latest)
    tag="$(fetch -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest" | sed 's|.*/tag/||')"
    case "$tag" in v[0-9]*) ;; *) fail "Couldn't find the latest release of $repo" ;; esac
    ;;
  v[0-9]*) tag="$requested" ;;
  *) fail "Versions look like v0.1.1" ;;
esac
base="https://github.com/$repo/releases/download/$tag"
curl -fsIL --proto '=https' --tlsv1.2 -o /dev/null "$base/SHA256SUMS" 2>/dev/null ||
  fail "There's no release $tag (see https://github.com/$repo/releases)"
step "Version      ${bold}${cyan}$tag${reset}${dim}  github.com/$repo/releases/tag/$tag${reset}"

# What's there now, if anything.
current=""
if [ -x "$bin_dir/t3mini" ]; then
  current="$("$bin_dir/t3mini" version 2>/dev/null || true)"
fi
if [ -n "$current" ]; then
  if [ "v$current" = "$tag" ]; then
    step "Current      ${dim}$current already, reinstalling${reset}"
  else
    step "Upgrading    ${dim}$current →${reset} ${bold}${tag#v}${reset}"
  fi
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

bytes="$(fetch -I "$base/$asset" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')"
mb() { echo $(($1 / 1048576)); }
size=""
[ "$bytes" -gt 0 ] && size="$(mb "$bytes") MB"
say "  ${cyan}↓${reset} Downloading  ${bold}$asset${reset}${size:+ ${dim}($size)${reset}}"
# In a terminal: a progress bar drawn from the file's size as it arrives.
bar() {
  width=30
  filled=$(($1 * width / bytes))
  [ "$filled" -gt "$width" ] && filled=$width
  line="" i=0
  while [ "$i" -lt "$width" ]; do
    if [ "$i" -lt "$filled" ]; then line="${line}█"; else line="${line}░"; fi
    i=$((i + 1))
  done
  # Under the values column ("  ↓ Downloading  " is 17 wide).
  printf '\r                 %s%s%s %3d%%  %s%s / %s MB%s ' "$cyan" "$line" "$reset" $(($1 * 100 / bytes)) \
    "$dim" "$(mb "$1")" "$(mb "$bytes")" "$reset" >&2
}
url="$base/$asset"
if [ -n "$tty" ] && [ "$bytes" -gt 0 ]; then
  printf '\033[?25l' >&2 # hide the cursor while drawing
  trap 'printf "\033[?25h" >&2; rm -rf "$work"' EXIT INT TERM
  curl -fsL --proto '=https' --tlsv1.2 -o "$work/$asset" "$url" &
  download=$!
  while kill -0 "$download" 2>/dev/null; do
    got=0
    [ -f "$work/$asset" ] && got="$(wc -c <"$work/$asset")"
    bar "$got"
    sleep 0.2
  done
  wait "$download" || fail "Couldn't download $url"
  bar "$bytes"
  printf '\n\033[?25h' >&2
else
  fetch -o "$work/$asset" "$url" || fail "Couldn't download $url"
fi
fetch -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "Couldn't download the checksums"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")"
[ -n "$expected" ] || fail "No checksum for $asset in this release"
[ "$(sum "$work/$asset")" = "$expected" ] || fail "Checksum mismatch: not installing it"
step "Checksum     ${dim}sha256 ${expected%"${expected#????????????}"}… matches${reset}"

mkdir -p "$bin_dir"
chmod 755 "$work/$asset"
# Moved into place in one step, so a running t3mini keeps its file until it restarts.
mv "$work/$asset" "$bin_dir/.t3mini.new"
mv "$bin_dir/.t3mini.new" "$bin_dir/t3mini"
step "Installed    ${bold}$bin_dir/t3mini${reset}"

say ""
case ":$PATH:" in
  *":$bin_dir:"*) run="t3mini" ;;
  *)
    run="$bin_dir/t3mini"
    case "${SHELL:-}" in
      */zsh) profile="~/.zshrc" ;;
      */bash) profile="~/.bashrc" ;;
      */fish) profile="~/.config/fish/config.fish" ;;
      *) profile="your shell profile" ;;
    esac
    say "  ${yellow}!${reset} $bin_dir isn't on your PATH. Add this to $profile:"
    say "      ${bold}export PATH=\"$bin_dir:\$PATH\"${reset}"
    say ""
    ;;
esac
# Running the version it replaced: say how to switch (t3mini update does this by itself).
pid_file="${T3_MINI_HOME:-$HOME/.t3-mini}/t3mini.pid"
if [ -n "$current" ] && [ "v$current" != "$tag" ] && [ -f "$pid_file" ] &&
  kill -0 "$(cat "$pid_file" 2>/dev/null)" 2>/dev/null; then
  say "  t3mini is still running $current. Switch to ${tag#v} with: ${bold}$run restart${reset}"
else
  say "  ${bold}Get started${reset}"
  say "    ${cyan}$run start${reset}   ${dim}run it → http://127.0.0.1:4011${reset}"
  say "    ${cyan}$run pair${reset}    ${dim}add this machine from another computer (Settings → Machines)${reset}"
  say "    ${cyan}$run help${reset}    ${dim}all commands${reset}"
fi
say ""
note "Claude Code and/or Codex need to be installed and signed in on this machine."
say ""
