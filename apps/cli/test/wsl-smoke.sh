#!/usr/bin/env bash
# Run from a checkout on the Linux filesystem as an ordinary WSL user.
set -euo pipefail
candidate=$(realpath "$1")
target_node=$2
qa_root=$(mktemp -d)
trap 'rm -rf "$qa_root"' EXIT

install_node() {
  local version=$1 directory="$qa_root/node-$1" base archive
  base="https://nodejs.org/dist/v$version"
  if [[ "$version" == 24 ]]; then base=https://nodejs.org/dist/latest-v24.x; fi
  mkdir -p "$directory"
  curl --fail --silent --show-error --location "$base/SHASUMS256.txt" -o "$directory/SHASUMS256.txt"
  archive=$(awk '$2 ~ /^node-v[0-9.]+-linux-x64.tar.xz$/ { print $2 }' "$directory/SHASUMS256.txt")
  test -n "$archive"
  curl --fail --silent --show-error --location "$base/$archive" -o "$directory/$archive"
  (cd "$directory" && sha256sum --check --ignore-missing SHASUMS256.txt)
  tar -xJf "$directory/$archive" --strip-components=1 -C "$directory"
  export PATH="$directory/bin:$PATH"
}

install_node 24
npm install --prefix "$qa_root/tools" --ignore-scripts --no-audit --no-fund pnpm@10.33.0
export PATH="$qa_root/tools/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts --filter greatping...
if [[ "$target_node" != 24 ]]; then install_node "$target_node"; fi
export GREATPING_TEST_REQUIRE_WSL=1
export GREATPING_TEST_WSL_VERSION=${3:?Pass the expected WSL version}
export GREATPING_TEST_PAIRING_FIXTURE="$candidate/fixtures/pairing-fetch.mjs"
export GREATPING_TEST_OPERATIONS_FETCH_FIXTURE="$candidate/fixtures/operations-fetch.mjs"
export GREATPING_TEST_ACCOUNT_FIXTURE="$candidate/fixtures/account.mjs"
node apps/cli/test/package-smoke.mjs "$candidate/greatping.tgz"
