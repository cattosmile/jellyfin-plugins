using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.AdminEnhancements.Configuration;

/// <summary>
/// Configuration for server-administration quality-of-life features.
/// </summary>
public sealed class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets a value indicating whether delete synchronization is enabled.
    /// This is disabled until an administrator explicitly enables it.
    /// </summary>
    public bool DeleteSynchronizationEnabled { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether destructive Seerr calls are only logged.
    /// </summary>
    public bool DryRun { get; set; } = true;

    /// <summary>
    /// Gets or sets the Seerr URL reachable from the Jellyfin container.
    /// </summary>
    public string SeerrUrl { get; set; } = "http://seerr:5055";

    /// <summary>
    /// Gets or sets the Seerr administrator API key.
    /// </summary>
    public string SeerrApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets a value indicating whether the matching file should be removed from Radarr or Sonarr.
    /// </summary>
    public bool RemoveFromDownloadManager { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether matching Seerr requests should be deleted.
    /// </summary>
    public bool DeleteSeerrRequests { get; set; } = true;

    /// <summary>
    /// Gets or sets the timeout used for one Seerr call.
    /// </summary>
    public int RequestTimeoutSeconds { get; set; } = 15;
}
