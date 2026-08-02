# cattosmile Jellyfin Plugins

Two server-side plugins for Jellyfin 10.11.x, distributed from one Jellyfin plugin repository:

- **Disk Space Indicator** — shows the complete filesystem volume usage in Jellyfin's drawer and provides a full library scan shortcut for every authenticated user.
- **Jellyfin Administrator Enhancements** — optionally synchronizes Jellyfin media deletions with Seerr and Radarr/Sonarr. Cleanup is disabled by default and configured only by an administrator.

## Install from the shared repository

Add this manifest URL in **Dashboard → Plugins → Repositories**:

```text
https://raw.githubusercontent.com/cattosmile/jellyfin-plugins/main/manifest.json
```

After refreshing the catalog, both plugins appear independently and can be installed or updated separately. Jellyfin 10.11.x is required because both projects target the 10.11 plugin ABI.

Jellyfin restarts are required after installing or updating a plugin. On its first startup, Disk Space Indicator automatically installs its small server-side hook into Jellyfin's hosted `index.html`; no browser extension or per-client installation is needed. The hook is idempotent and is reapplied after a Jellyfin image update if necessary.

## Local build

```bash
dotnet build Jellyfin.Plugin.DiskSpaceIndicator/Jellyfin.Plugin.DiskSpaceIndicator.csproj --configuration Release
dotnet build Jellyfin.Plugin.AdministratorEnhancements/Jellyfin.Plugin.AdministratorEnhancements.csproj --configuration Release
```

The `packaging/` metadata files are included in each distributable ZIP next to the published plugin files. The checked-in `releases/` ZIPs are the files referenced by `manifest.json`.

## Disk Space Indicator

The plugin reads the filesystem volume containing `/` by default, so it reports the complete volume visible to the Jellyfin container rather than only media-library files. Its drawer card is server-side and uses the current Jellyfin user's authenticated session.

The `Scan All Libraries` action calls Jellyfin's normal library scan task. It does not start a second scanner and polls the existing task for progress.

## Administrator Enhancements

The plugin observes Jellyfin media deletions and, when enabled, removes the matching Seerr request and Radarr/Sonarr media entry. The Seerr URL and administrator API key are stored in Jellyfin's plugin configuration and are never exposed to regular users. The default Docker-network URL is `http://seerr:5055`.

The cleanup option is intentionally disabled by default. The server administrator must enable it after configuring and testing the Seerr connection.

## Repository layout

`manifest.json` is the single catalog consumed by Jellyfin. It contains two plugin entries, each with its own GUID, version, checksum, and ZIP URL. The plugin source projects remain separate so each plugin can be released independently while the catalog stays shared.
