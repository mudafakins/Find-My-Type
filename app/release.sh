#!/bin/zsh
# Publish a new version:  app/release.sh 2.2.0
#
# Sets app/VERSION, commits it, tags v2.2.0 and pushes. GitHub Actions then builds the
# Mac and Windows apps and publishes the release; installed apps offer the update.
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  echo "Usage: app/release.sh <major.minor.patch>   (current: $(cat "${0:A:h}/VERSION"))" >&2
  exit 1
fi

cd "${0:A:h}/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "Tag v$VERSION already exists." >&2
  exit 1
fi

print -r -- "$VERSION" > app/VERSION
git add app/VERSION
git diff --cached --quiet || git commit -m "Release v$VERSION"   # no commit if VERSION already matches
git tag -a "v$VERSION" -m "Find My Type $VERSION"
git push origin HEAD "v$VERSION"

echo "✓ Pushed v$VERSION. Watch the build under the repository's Actions tab;"
echo "  the release appears under Releases when both apps are built."
