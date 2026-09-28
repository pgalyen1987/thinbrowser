#!/usr/bin/env bash
# Rename the project everywhere, in one pass.
#
#   bash tools/rename.sh            # show what would change
#   bash tools/rename.sh --go       # do it
#
# WHY IT IS A SCRIPT. The name is in 17 files inside the repo and four places outside it (the
# site page, distribution-kit's apps.json, the boss registry, the MCP registry entry). A rename
# done by hand leaves one surface behind, and a half-renamed product is worse than the old name:
# the npm page says one thing, the README another, and a stranger concludes nobody is home.
#
# The name is a variable at the top because it changed three times before it settled, and the
# next person should be able to try one without unpicking the last.
#
# WHAT IT DELIBERATELY DOES NOT DO: publish to npm, rename the GitHub repo, or touch the MCP
# registry. Those are outward and irreversible-ish; they are listed at the end for a human.
set -uo pipefail

OLD="agent-browser"
NEW="thinbrowser"
OLD_ENV="AB_"
NEW_ENV="TB_"
GO=0; [[ "${1:-}" == "--go" ]] && GO=1
cd "$(dirname "$0")/.." || exit 1

# The script excludes ITSELF: sed would rewrite its own OLD="agent-browser" line to the new
# name, so a second run would have nothing to find and the record of what was renamed would be
# gone. package-lock.json is excluded too -- a renamed package needs the lock REGENERATED, not
# string-substituted, or the integrity hashes describe a package that no longer exists.
files=$(grep -rl "$OLD\|$OLD_ENV" . 2>/dev/null \
  | grep -v node_modules | grep -v '^\./\.git/' | grep -v 'package-lock.json' \
  | grep -v 'tools/rename.sh' | sort)

echo "files carrying the old name: $(echo "$files" | grep -c .)"
if [ "$GO" = "0" ]; then
  echo "$files" | sed 's/^/  /'
  echo
  echo "would replace: $OLD -> $NEW, and the env prefix $OLD_ENV -> $NEW_ENV"
  echo "dry run. pass --go to apply."
  exit 0
fi

for f in $files; do
  # The env prefix first: AB_CDP -> LB_CDP. Bounded to the known variables so a stray "AB_" in
  # prose is not mangled.
  sed -i -E "s/\b${OLD_ENV}(CDP|CDP_PORT|HEADED|PROFILE|CREDS|BROWSER|CHANNEL|EPHEMERAL|DOWNLOADS)\b/${NEW_ENV}\1/g" "$f"
  sed -i "s/${OLD}/${NEW}/g" "$f"
done

echo "renamed in $(echo "$files" | grep -c .) file(s)"
echo
echo "STILL TO DO BY HAND (outward, and not this script's business):"
echo "  1. gh repo rename $NEW            (GitHub redirects the old URL, so links survive)"
echo "  2. npm publish                     (the bare name '$NEW' is free; the old scoped package"
echo "                                      stays published and should be deprecated, not unpublished)"
echo "  3. npm deprecate @rebelstudios/${OLD} \"renamed to ${NEW}\""
echo "  4. mcp-publisher publish           (server.json now says $NEW)"
