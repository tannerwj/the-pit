#!/usr/bin/env python3
"""Print the Cloudflare API token (surrogate credential) for wrangler.
Usage: export CLOUDFLARE_API_TOKEN=$(python3 scripts/cf_token.py)
Never print this in logs; use it only as an env var for wrangler/d1 calls."""
import sys

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import dynamic_credential_entry

print(dynamic_credential_entry("custom.cloudflare")["surrogate"], end="")
