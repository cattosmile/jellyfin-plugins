# Jellyfin Plugins

- **Disk Space Indicator** — shows the complete filesystem volume usage in Jellyfin's drawer and provides a full library scan shortcut for every authenticated user.
- **Jellyfin Administrator Enhancements** — optionally synchronizes Jellyfin media deletions with Seerr and Radarr/Sonarr. Cleanup is disabled by default and configured only by an administrator.

## Install from the shared repository

Add this manifest URL in **Dashboard → Plugins → Repositories**:

```text
https://raw.githubusercontent.com/cattosmile/jellyfin-plugins/main/manifest.json
```

## Disk Space Indicator

The plugin reads the filesystem volume containing `/` by default, so it reports the complete volume visible to the Jellyfin container rather than only media-library files. Its drawer card is server-side and uses the current Jellyfin user's authenticated session.

The `Scan All Libraries` action calls Jellyfin's normal library scan task. It does not start a second scanner and polls the existing task for progress.

## Administrator Enhancements

The plugin observes Jellyfin media deletions and, when enabled, removes the matching Seerr request and Radarr/Sonarr media entry. The Seerr URL and administrator API key are stored in Jellyfin's plugin configuration and are never exposed to regular users. The default Docker-network URL is `http://seerr:5055`.

The cleanup option is intentionally disabled by default. The server administrator must enable it after configuring and testing the Seerr connection.
