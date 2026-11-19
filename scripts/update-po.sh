#!/usr/bin/env bash
# Re-extract English messages and merge them into every po/<lang>.po.
# Changed paragraphs become "fuzzy" and fall back to English until updated.
# Needs GNU gettext (msgmerge).
set -euo pipefail
cd "$(dirname "$0")/.."
MDBOOK_OUTPUT='{"xgettext": {"pot-file": "messages.pot"}}' mdbook build -d po
for po in po/*.po; do
  msgmerge --update --backup=none "$po" po/messages.pot
done
