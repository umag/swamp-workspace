#!/usr/bin/env bash
#
# Extract ONE version's section from an extension CHANGELOG.md.
#
# SINGLE SOURCE OF TRUTH. `scripts/release_notes_gate.ts` is the only caller
# left: `--mode validate` (release-notes-cap) and the extension-publish
# pre-flight/publish loop both run it and both trust its exit code — swamp-
# registry release notes are IMMUTABLE per version, so anything the publisher
# ships must be exactly what the guard already validated.
#
# Usage: changelog-section.sh <path-to-CHANGELOG.md> <version>
# On success (exit 0) prints the section on stdout, heading included,
# untruncated. On every failure stdout is EMPTY — the caller decides what an
# absent/broken section means; this script only reports WHY it found nothing.
#
# Exit codes:
#   0 = section found and its body has at least one non-whitespace line
#       (heading included, untruncated, printed on stdout)
#   3 = the CHANGELOG file does not exist
#   4 = the file exists but has no heading for this version
#   5 = the heading exists but the body under it is entirely blank
#   6 = the version's heading appears MORE THAN ONCE, back to back (see the
#       RESIDUAL note below — a duplicate separated by another version's
#       section is not detected as one)
#
# HEADING FORMS ACCEPTED. Both `## <version>` (optionally followed by a
# suffix, e.g. "## 2026.08.19.1 — some title") and the bracketed
# `## [<version>]` form `lastfm` uses (e.g. "## [2026.07.27.1] — 2026-07-27").
# Matching is LITERAL substring matching via awk's index(), never a regex
# built from the version string — `.` in a CalVer version must never become a
# wildcard. The `substr(...) !~ /[0-9.]/` guard on the plain form stops
# `## 2026.08.19.1` from also matching a `## 2026.08.19.10` heading; the
# bracketed form needs no such guard because `]` terminates it unambiguously.
#
# RESIDUAL, deliberate: duplicate-heading detection (exit 6) only fires when
# the SAME heading is hit again before any OTHER `## ` heading is seen — the
# extraction terminates at the first `## ` line that is not the target
# heading (see the `f && /^## /` rule below), so a second occurrence of the
# target heading SEPARATED by another version's section is never reached and
# is not reported as a duplicate. Adjacent duplicates (a copy-paste error,
# the realistic case) are caught.
#
# DELIBERATE NON-GOAL: a body consisting only of an HTML comment (e.g.
# "<!-- TODO: write these notes -->") PASSES as a real section (exit 0).
# Catching it needs either multi-line HTML-comment state (which would
# false-positive on a section that legitimately opens with a comment) or an
# arbitrary minimum-length rule. Not implemented; see cipg-plan-v4's
# potentialChallenges for the rationale.
#
# IMPLEMENTATION NOTE: the awk program BUFFERS the section into a variable
# and prints it only from END, on success. A print-as-you-go shape cannot
# honour "stdout empty on failure" for exit 5 — the heading would already be
# on stdout by the time END discovers the body was blank.
set -uo pipefail

changelog="${1:?usage: changelog-section.sh <changelog> <version>}"
version="${2:?usage: changelog-section.sh <changelog> <version>}"

[ -f "$changelog" ] || exit 3

rc=0
awk -v v="$version" '
  (index($0, "## " v) == 1 && substr($0, length("## " v) + 1, 1) !~ /[0-9.]/) ||
  (index($0, "## [" v "]") == 1) {
    if (f) { dup = 1; exit }
    f = 1; out = out $0 ORS; next
  }
  f && /^## / { exit }
  f { if ($0 ~ /[^[:space:]]/) body = 1; out = out $0 ORS }
  END {
    if (dup) exit 6
    if (!f) exit 4
    if (!body) exit 5
    printf "%s", out
  }
' "$changelog" || rc=$?
exit "$rc"
