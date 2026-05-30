#!/usr/bin/env bash
# Build the desktop installer for THIS machine's OS, and explain how to get the
# other one. A Windows .exe cannot be reliably built on macOS (and vice-versa),
# so "both at once" is the GitHub Action (one trigger -> .dmg + .exe artifacts).
set -euo pipefail
cd "$(dirname "$0")/.."

os="$(uname -s)"
echo "==> Building desktop installer for: $os"

case "$os" in
  Darwin)
    echo "==> macOS .dmg (universal: Intel + Apple Silicon, unsigned)…"
    CSC_IDENTITY_AUTO_DISCOVERY=false npm run app:mac
    echo ""
    echo "✓ Built: dist/*.dmg"
    echo "ℹ To also get the Windows .exe (can't be built reliably on macOS):"
    echo "    • on a Windows PC:   npm ci && npm run app:win"
    echo "    • or BOTH on CI:     push a 'v*' git tag, or run the"
    echo "      'Build desktop installers' GitHub Action (.github/workflows/build-installers.yml)."
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "==> Windows .exe (NSIS, unsigned)…"
    npm run app:win
    echo ""
    echo "✓ Built: dist/*.exe"
    echo "ℹ To also get the macOS .dmg, run 'npm run app:mac' on a Mac, or use the GitHub Action."
    ;;
  *)
    echo "Unsupported host OS for direct installer builds ($os)."
    echo "Use the GitHub Action (build-installers.yml): it builds the .dmg on macOS and the .exe on Windows runners."
    exit 1
    ;;
esac
