#!/bin/bash
# Deterministically (re)creates the demo repo record-demo.sh runs against
# (default ~/Downloads/demo-express) from scratch - a full clone of
# expressjs/express pinned to one specific commit, plus several local-only
# fixture branches so the commit graph has something genuinely busy to show:
# multiple independent lines forking from the same point, one of which
# itself merges two parallel commits back together. master's own history is
# never touched.
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
# Every fixture commit below gets an explicit GIT_AUTHOR_DATE/
# GIT_COMMITTER_DATE, one minute apart, instead of leaving them at whatever
# the wall clock reads when this script happens to run. `git log`'s default
# order is reverse-chronological by commit date - real wall-clock
# timestamps would still normally come out increasing step by step, but
# leaves the exact row order (and thus every hardcoded row_y() position in
# record-demo.sh) at the mercy of how fast this script happens to execute
# on a given machine, including two commits landing in the same second.
# Fixed dates make the resulting row order exactly reproducible every time.
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

# Every fixture commit touches package.json itself (the same file the
# demo's log view is scoped to), each on its own distinct, previously-unused
# line of the keywords array - so every one of them is actually
# visible/selectable in that package.json-scoped log, and none of their
# diffs conflict with each other when merged. Picks from whatever's left
# unused in the array as of the pinned commit:
#   "api"      -> feature/rate-limit-docs        (existing)
#   "restful"  -> feature/rate-limit-docs-faq     (existing, merged into the above)
#   "web"      -> feature/caching-docs            (new)
#   "http"     -> feature/websocket-docs           (new)
#   "router"   -> feature/security-headers-docs     (new)
# If the pinned commit ever changes, re-check `keywords` in package.json for
# what's still unused there.

fixture_commit() {
    local branch="$1" date="$2" file="$3" content="$4" keyword="$5" suffix="$6" message="$7"
    git checkout --quiet -b "$branch" master
    mkdir -p docs
    printf '%s' "$content" > "$file"
    sed -i "s/^    \"${keyword}\",\$/    \"${keyword}\",\n    \"${suffix}\",/" package.json
    git add "$file" package.json
    GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" \
        git -c user.name="david" -c user.email="david@narine.org" \
        commit --quiet -m "$message"
}

echo "=== Creating the local-only feature/rate-limit-docs fixture branch ==="
# A dedicated branch+commit purely so the Branches-filter segment has a
# second, real branch (besides master) to filter the log down to.
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
GIT_AUTHOR_DATE="2026-08-01T10:00:00-05:00" GIT_COMMITTER_DATE="2026-08-01T10:00:00-05:00" \
    git -c user.name="david" -c user.email="david@narine.org" \
    commit --quiet -m "docs: add guidance on rate limiting middleware"

echo "=== Creating a second, parallel branch to merge into it - a real merge for the commit graph to show ==="
# Branches off the SAME point as feature/rate-limit-docs (master, not on
# top of its docs commit) - a genuinely independent line of work, not a
# follow-up commit. Touches package.json too, same as the docs commit
# above, but on a different line ("restful", not "api") - git auto-merges
# the two cleanly (nothing to actually conflict on), but critically, the
# merge's own package.json content then differs from EITHER parent alone
# (it has both insertions). That's what makes the merge commit itself
# "interesting" enough to survive git's history simplification and still
# show up as its own row in the demo's package.json-scoped log - if both
# branches only touched their own separate new file, the merge would be
# TREESAME to either parent on package.json specifically and get
# simplified away, leaving nothing for this demo to actually show.
git checkout --quiet master
git checkout --quiet -b feature/rate-limit-docs-faq
mkdir -p docs
cat > docs/rate-limiting-faq.md <<'EOF'
# Rate Limiting FAQ

**Does Express rate-limit by default?**
No - see docs/rate-limiting.md for how to add it yourself.

**Can I rate-limit only specific routes?**
Yes - apply the middleware to a specific router or route instead of the
whole app.
EOF
sed -i 's/^    "restful",$/    "restful",\n    "faq-friendly",/' package.json
git add docs/rate-limiting-faq.md package.json
GIT_AUTHOR_DATE="2026-08-01T10:01:00-05:00" GIT_COMMITTER_DATE="2026-08-01T10:01:00-05:00" \
    git -c user.name="david" -c user.email="david@narine.org" \
    commit --quiet -m "docs: add rate limiting FAQ"

echo "=== Merging it into feature/rate-limit-docs - the actual merge commit ==="
git checkout --quiet feature/rate-limit-docs
GIT_AUTHOR_DATE="2026-08-01T10:02:00-05:00" GIT_COMMITTER_DATE="2026-08-01T10:02:00-05:00" \
    git -c user.name="david" -c user.email="david@narine.org" \
    merge --quiet --no-ff -m "Merge branch 'feature/rate-limit-docs-faq' into feature/rate-limit-docs" feature/rate-limit-docs-faq
# The branch ref itself isn't needed anymore - its commit is still fully
# reachable (and shown) via the merge above. Deleting it keeps the
# Branches submenu's list exactly what the demo expects (master +
# feature/rate-limit-docs + the 3 branches below, nothing else).
git branch -D feature/rate-limit-docs-faq
git checkout --quiet master

echo "=== Creating 3 more independent single-commit branches off master ==="
# Purely to make the "All branches" combined graph genuinely busy - several
# lines forking from the exact same point, alongside the merge shape above,
# instead of just one branch. Each is a simple, unmerged single commit (no
# extra merge complexity needed - the fixture above already covers that
# shape); each dated later than the merge so they render as the newest,
# topmost rows once combined.
fixture_commit "feature/caching-docs" "2026-08-01T10:03:00-05:00" \
    "docs/caching.md" \
'# Caching

Express does not cache responses by default. Use the `Cache-Control` and
`ETag` response headers (both settable directly via `res.set`) to let
clients and intermediate proxies cache responses themselves, or place a
reverse proxy cache (e.g. Varnish, a CDN) in front of the app for
full-response caching.
' \
    "web" "cache-friendly" "docs: add guidance on response caching"

fixture_commit "feature/websocket-docs" "2026-08-01T10:04:00-05:00" \
    "docs/websockets.md" \
'# WebSockets

Express itself only handles HTTP request/response cycles - it has no
built-in WebSocket support. Pair it with a dedicated library (such as
`ws` or `socket.io`) attached to the same underlying HTTP server Express
listens on.
' \
    "http" "websocket-friendly" "docs: add guidance on WebSocket support"

fixture_commit "feature/security-headers-docs" "2026-08-01T10:05:00-05:00" \
    "docs/security-headers.md" \
'# Security Headers

Express does not set security-related HTTP headers by default. Use a
dedicated middleware (such as `helmet`) placed early in the middleware
stack to set headers like `X-Content-Type-Options`, `X-Frame-Options`,
and a `Content-Security-Policy`.
' \
    "router" "security-friendly" "docs: add guidance on security headers"

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
