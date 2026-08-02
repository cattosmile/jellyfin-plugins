#!/usr/bin/env bash
set -euo pipefail

web_root="${1:-/usr/share/jellyfin/web}"
index_file="$web_root/index.html"
marker='<!-- disk-space-indicator:start -->'

if [[ ! -f "$index_file" ]]; then
    printf 'Jellyfin web index not found: %s\n' "$index_file" >&2
    exit 1
fi

if grep -Fq "$marker" "$index_file"; then
    exit 0
fi

tmp_file="${index_file}.disk-space.tmp"
perl -0pe 's{</head>}{    <!-- disk-space-indicator:start -->\n    <script defer src="/DiskSpace/Script"></script>\n    <!-- disk-space-indicator:end -->\n</head>}' \
    "$index_file" > "$tmp_file"
mv "$tmp_file" "$index_file"
