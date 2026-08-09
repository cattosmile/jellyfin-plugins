# The great Cattomile's greatest Jellyfin Plugins

- **Disk Space Indicator** — shows the complete filesystem volume usage in Jellyfin's drawer and provides a full library scan shortcut.
- **Admin Enhancements** — synchronizes Jellyfin media deletions with Seerr.
- **Audio Delay** — adjusts audio timing in the web player and locks a per-track delay for a whole series season.

## Install from the shared repository

Add this manifest URL in **Dashboard → Plugins → Repositories**:

```text
https://raw.githubusercontent.com/cattosmile/jellyfin-plugins/main/manifest.json
```

## Disk Space Indicator

The plugin reads the filesystem volume containing `/`, so it reports the host filesystem's total and available space.

The `Scan All Libraries` action calls Jellyfin's normal library scan task.

## Admin Enhancements

The plugin observes Jellyfin media deletions and, when enabled, removes the matching Seerr request and Radarr/Sonarr media entry. The Seerr URL and administrator API key are stored in Jellyfin's plugin configuration.

The cleanup option is intentionally disabled by default. The server administrator must enable it after configuring and testing the Seerr connection.

## Audio Delay

Open the player's gear menu while an episode is playing and choose **Audio Delay**. Positive values make the audio play later; negative values make it play earlier. The **Lock for this season** action stores the selected value for the current series, season and audio track. Switching to another audio track uses its own setting, or no delay when it has not been locked.
