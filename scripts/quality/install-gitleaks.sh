#!/usr/bin/env bash
set -euo pipefail

# Reviewed release digests from github.com/gitleaks/gitleaks v8.30.1.
# Keep the scanner's required version in check-secrets.mjs in sync.
version=8.30.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin_arm64; checksum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin-x86_64) platform=darwin_x64; checksum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Linux-aarch64|Linux-arm64) platform=linux_arm64; checksum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Linux-x86_64) platform=linux_x64; checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  *) echo 'Unsupported bootstrap platform. Install Gitleaks 8.30.1 and set GITLEAKS_BIN.' >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/../.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 60 \
  "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_${platform}.tar.gz" \
  --output "$temporary/archive.tar.gz"
if [[ "$platform" == darwin_* ]]; then
  printf '%s  %s\n' "$checksum" "$temporary/archive.tar.gz" | shasum -a 256 -c -
else
  printf '%s  %s\n' "$checksum" "$temporary/archive.tar.gz" | sha256sum -c -
fi
tar -xzf "$temporary/archive.tar.gz" -C "$temporary" gitleaks
test "$("$temporary/gitleaks" version)" = "$version"
mkdir -p "$root/.tools"
install -m 755 "$temporary/gitleaks" "$root/.tools/gitleaks"
echo "Installed Gitleaks $version in .tools/gitleaks"
