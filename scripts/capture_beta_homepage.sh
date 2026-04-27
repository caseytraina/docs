#!/usr/bin/env bash

set -euo pipefail

output_path="${1:-images/generated/beta-homepage-raw.png}"

node scripts/capture_beta_homepage.mjs --output "$output_path"
