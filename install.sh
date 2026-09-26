#!/bin/sh
# Install tabdriver on macOS or Linux and register it with your browsers.
#
#   curl -fsSL https://raw.githubusercontent.com/trajche/tabdriver/main/install.sh | sh
#
# TABDRIVER_INSTALL_DIR overrides the install folder (default ~/.local/bin),
# TABDRIVER_VERSION picks a release tag (default: latest).
set -eu

REPO="trajche/tabdriver"
DIR="${TABDRIVER_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported system: $(uname -s). On Windows use install.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

if [ -n "${TABDRIVER_VERSION:-}" ]; then
  url="https://github.com/$REPO/releases/download/$TABDRIVER_VERSION/tabdriver_${os}_${arch}.tar.gz"
else
  url="https://github.com/$REPO/releases/latest/download/tabdriver_${os}_${arch}.tar.gz"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL "$url" | tar -xz -C "$tmp" tabdriver
mkdir -p "$DIR"
install -m 755 "$tmp/tabdriver" "$DIR/tabdriver"
echo "Installed $DIR/tabdriver"
echo

"$DIR/tabdriver" install

case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo; echo "Add $DIR to your PATH, e.g.: echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.zshrc" ;;
esac
echo
echo "Next: install the browser extension and add tabdriver to your agent. Run 'tabdriver' for the exact lines."
