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

# The sidebar lives in toc.js / toc.html, whose names never change, so browsers
# can keep showing an old table of contents after a deploy. Add a version query.
ver=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
find book -name '*.html' -print0 | xargs -0 sed -i -E \
  -e "s#(<script src=\"[^\"]*toc\\.js)\">#\\1?v=$ver\">#" \
  -e "s#(<iframe class=\"sidebar-iframe-outer\" src=\"[^\"]*toc\\.html)\">#\\1?v=$ver\">#"
