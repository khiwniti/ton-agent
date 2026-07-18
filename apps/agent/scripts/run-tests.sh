#!/usr/bin/env bash
#
# Test runner with per-file process isolation.
#
# Why a script instead of `tsx --test test/*.ts`?
#   The agent's config.ts + storage/store.ts export EAGER singletons that read
#   process.env / open SQLite at import time. Node's single-process test runner
#   shares the module cache across every file, so the first import freezes the
#   config and later files that set DATA_DIR / WALLET_MASTER_MNEMONIC are
#   ignored — and SQLite state bleeds between suites.
#
#   Node 22+ has `--test-isolation=process`; we target Node 20, so we spawn one
#   process per file here. Same isolation, portable.
#
# Each file gets a FRESH DATA_DIR (tmp SQLite) and the fixed test mnemonic so
# suites never touch real funds or each other's DB.
set -euo pipefail

cd "$(dirname "$0")/.."

TSX="../../node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then TSX="tsx"; fi

TEST_MNEMONIC="test test test test test test test test test test test junk"

fail=0
pass_files=0
for f in test/*.test.ts test/*.test.mts; do
  [ -e "$f" ] || continue
  data_dir="$(mktemp -d)"
  echo ""
  echo "▶ $f"
  if env DATA_DIR="$data_dir" \
        WALLET_MASTER_MNEMONIC="$TEST_MNEMONIC" \
        "$TSX" --test "$f"; then
    pass_files=$((pass_files + 1))
  else
    echo "✗ FAILED: $f"
    fail=$((fail + 1))
  fi
  rm -rf "$data_dir"
done

echo ""
echo "════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then
  echo "✓ ALL TEST FILES PASSED ($pass_files files)"
  exit 0
else
  echo "✗ $fail test file(s) FAILED"
  exit 1
fi
