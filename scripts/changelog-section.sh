#!/usr/bin/env bash
#
# Extract ONE version's section from an extension CHANGELOG.md.
#
# SINGLE SOURCE OF TRUTH. Both CI jobs call this:
#   - `release-notes-cap`  measures the section against $REGISTRY_NOTES_CAP
#     while the change is still a PR, so an over-cap section is caught before
#     it can ship.
#   - `extension-publish`  passes the section to `swamp extension push
#     --release-notes`.
# They MUST agree byte for byte: swamp-registry release notes are IMMUTABLE per
# version, so anything the publisher truncates is truncated forever. When the
# guard and the publisher each carried their own copy of this awk program, the
# guard could pass while the publisher shipped something different.
#
# Usage: changelog-section.sh <path-to-CHANGELOG.md> <version>
# Prints the section (heading included) on stdout, untruncated. Prints nothing
# and exits 0 when the file or the section is absent — callers decide whether
# an absent section is an error.
#
# The `substr(...) !~ /[0-9.]/` guard stops `## 2026.08.19.1` from also matching
# a `## 2026.08.19.10` heading.
set -eo pipefail

changelog="${1:?usage: changelog-section.sh <changelog> <version>}"
version="${2:?usage: changelog-section.sh <changelog> <version>}"

[ -f "$changelog" ] || exit 0

awk -v v="$version" '
  index($0, "## " v) == 1 && substr($0, length("## " v) + 1, 1) !~ /[0-9.]/ { f = 1; print; next }
  f && /^## / { exit }
  f { print }
' "$changelog"
