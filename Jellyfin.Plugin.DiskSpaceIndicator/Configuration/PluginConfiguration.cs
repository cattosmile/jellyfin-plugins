using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.DiskSpaceIndicator.Configuration;

/// <summary>
/// Configuration for the disk-space indicator.
/// </summary>
public sealed class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the filesystem path whose containing volume is measured.
    /// </summary>
    public string RootPath { get; set; } = "/";
}
