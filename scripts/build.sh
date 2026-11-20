#!/usr/bin/env bash
# Build the English book into book/ and every translation into book/<lang>/.
# Used both locally and by .github/workflows/pages.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

# Language code -> translated book title.
declare -A TITLES=(
  [zh-CN]="写给 C++ 程序员的 Rust 入门手册"
)

rm -rf book
mdbook build -d book
for po in po/*.po; do
  lang=$(basename "$po" .po)
  echo "Building $lang"
  MDBOOK_BOOK__LANGUAGE="$lang" \
  MDBOOK_BOOK__TITLE="${TITLES[$lang]:-Rust for C++ Programmers}" \
    mdbook build -d "book/$lang"
done
