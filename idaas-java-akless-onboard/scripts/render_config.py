#!/usr/bin/env python3
"""Validate delivered config or render a pilot; implementation lives in the local akless_config module."""
from akless_config import main, validate, resolve_config_path, PAM_SCOPE

if __name__ == '__main__':
    main(default_lang="java")
