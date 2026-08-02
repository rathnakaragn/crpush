# crpush — recipes. `just ci` is the pre-push gate.

default:
    @just --list

# pre-push gate: typecheck + unit tests — don't push without this green
ci: typecheck test

# tsc --noEmit, failing only on errors outside node_modules
# (vitest/workers-types lib conflicts in node_modules are known noise)
typecheck:
    #!/usr/bin/env bash
    set -uo pipefail
    errors=$(npx tsc --noEmit 2>&1 | grep 'error TS' | grep -v '^node_modules/' || true)
    if [ -n "$errors" ]; then
        echo "$errors"
        exit 1
    fi
    echo "typecheck clean"

test:
    npm test

# integration tests (workers pool, slower — not part of `ci`... run before deploy)
test-integration:
    npm run test:integration

dev:
    npm run dev

# deploy to Cloudflare, gated on ci + integration tests
deploy: ci test-integration
    npm run deploy
