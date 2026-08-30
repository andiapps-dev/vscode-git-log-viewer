#!/bin/bash
# Deterministically (re)creates the demo repo record-demo.sh runs against
# (default ~/Downloads/demo-express) from scratch - a full clone of
# expressjs/express pinned to one specific commit, plus one local-only
# fixture branch/commit for the Branches-filter segment to demonstrate
# filtering the log to something other than the checked-out branch.
#
# Why this needs to exist at all: record-demo.sh's row_y() helper and a
# long list of hardcoded SHA comments throughout it are calibrated against
# the EXACT commit history package.json has as of one specific point in
# time. express is a real, actively-developed project - a plain `git
# clone` run today gives a different HEAD than one run next month, with
# different commits at every row_y() position record-demo.sh assumes.
# record-demo.sh's own step 0 never fetches (see its comment there), which
# keeps an EXISTING checkout frozen - but that's an implicit rule ("don't
# run git fetch/pull in this directory"), not something enforced, and does
# nothing to help you recreate the directory if it's ever lost. This script
# is both: the explicit, one-command way to recreate it identically, and
# (via removing the 'origin' remote at the end) a structural guard against
# an accidental fetch/pull silently invalidating it in place.
#
# Safe to re-run: wipes and recreates the target directory every time.
#
# Usage: ./setup-demo-repo.sh [path-to-create]
set -euo pipefail

DEMO_REPO="${1:-$HOME/Downloads/demo-express}"

# record-demo.sh's own comments (row_y, segment 6b, segment 7, ...) name
# this commit directly - if it's ever intentionally changed, that's a lot
# of comments (and possibly row positions/content assumptions) to revisit
# alongside it, not just this one line.
PINNED_SHA="a3714473feb3d2908add734d340e7755fd85e0a3"

echo "=== Cloning expressjs/express into $DEMO_REPO ==="
rm -rf "$DEMO_REPO"
git clone --quiet https://github.com/expressjs/express.git "$DEMO_REPO"

cd "$DEMO_REPO"
echo "=== Pinning master to $PINNED_SHA ==="
git checkout --quiet master
git reset --hard --quiet "$PINNED_SHA"

echo "=== Creating the local-only feature/rate-limit-docs fixture branch ==="
# A dedicated branch+commit purely so the Branches-filter segment has a
# second, real branch (besides master) to filter the log down to -
# deliberately touches package.json (the same file the demo's log view is
# scoped to, so this commit is actually visible/selectable there) alongside
# a new docs file.
git checkout --quiet -b feature/rate-limit-docs
mkdir -p docs
cat > docs/rate-limiting.md <<'EOF'
# Rate Limiting

Express does not include built-in rate limiting. For production
deployments, pair Express with a dedicated rate-limiting middleware
(such as `express-rate-limit`) placed early in your middleware stack,
before route handlers that perform expensive work.

A minimal example:

```js
const rateLimit = require('express-rate-limit')

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
}))
```
EOF
# Targeted single-line insertion (not a JSON parse/rewrite) so the diff is
# exactly the one line added, matching a real-looking commit - a
# parse-and-rewrite would reformat the whole file. "api" (4-space indent,
# no trailing comma) is the last entry in package.json's keywords array as
# of the pinned commit; if that ever changes, this needs revisiting anyway
# since PINNED_SHA would have changed too.
sed -i 's/^    "api"$/    "api",\n    "rate-limiting-friendly"/' package.json
git add docs/rate-limiting.md package.json
git -c user.name="david" -c user.email="david@narine.org" \
    commit --quiet -m "docs: add guidance on rate limiting middleware"
git checkout --quiet master

echo "=== Removing the 'origin' remote ==="
# The actual freeze: with no remote configured, git fetch/pull in this
# directory can't silently move master or pull in history that would shift
# every row_y() position in record-demo.sh - it structurally can't happen
# by accident, not just "please don't". Re-add it deliberately
# (`git remote add origin https://github.com/expressjs/express.git`) if you
# ever need to fetch something here on purpose - re-run this whole script
# afterward to get back to the pinned, frozen state.
git remote remove origin

echo "=== Done ==="
git log --oneline -1 master
git branch -a
