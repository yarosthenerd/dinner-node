#!/usr/bin/env bash
# Start the second provider on this machine.
#
# A separate key, a separate model and a separate rate, so the chain shows two
# providers rather than one wearing two hats. The model is the smallest in the
# catalog and runs on CPU, so it coexists with the GPU node instead of evicting
# it, and it is the configuration an old laptop or a cheap VPS would run.
#
# Config lives in .env.node2, which is gitignored because it holds a private
# key. dotenv does not override variables already in the environment, so
# exporting them here is what makes this node differ from the default one.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.node2 ] || { echo "missing .env.node2"; exit 1; }
set -a; . ./.env.node2; set +a
echo "starting node2: ${MODEL} on :${PORT}"
exec npx tsx src/host.ts
