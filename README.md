# Jellyfin Plugins

- **Disk Space Indicator** — shows the complete filesystem volume usage in Jellyfin's drawer and provides a full library scan shortcut.
- **Jellyfin Administrator Enhancements** — Synchronizes Jellyfin media deletions with Seerr. 

## Install from the shared repository

Add this manifest URL in **Dashboard → Plugins → Repositories**:

```text
https://raw.githubusercontent.com/cattosmile/jellyfin-plugins/main/manifest.json
```

## Disk Space Indicator

The plugin reads the filesystem volume containing `/`, so it reports the complete host-file systems availale stpace and totalö space

The `Scan All Libraries` action calls Jellyfin's normal library scan task. 

## Admin Enhancements

The plugin observes Jellyfin media deletions and, when enabled, removes the matching Seerr request and Radarr/Sonarr media entry. The Seerr URL and administrator API key are stored in Jellyfin's plugin configuration.

The cleanup option is intentionally disabled by default. The server administrator must enable it after configuring and testing the Seerr connection.
