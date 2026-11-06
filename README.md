# Quilcast builds

Written by CI on each push to main it builds (scripts/publish-build.sh): `<build>.json` holds the SHA-256 of every file of a build and of the inline scripts its pages may run, with the first commit built into it; `commits/<sha>` names the build a commit makes. `node scripts/verify.mjs` (on main) checks quilcast.com against them; README, "Verify this build".
