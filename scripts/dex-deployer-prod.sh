#!/bin/bash
npx ts-node \
misc/scripts/dex-deployer-prod.ts \
--eth-node="https://nodes.chandrastation.com/evm/althea/" \
--eth-privkey="PRIVATE KEY HERE" \
--artifacts-root="artifacts/contracts/"
