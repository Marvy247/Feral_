#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/feral_vault.wasm res/feral_vault.wasm
echo "Built res/feral_vault.wasm"
