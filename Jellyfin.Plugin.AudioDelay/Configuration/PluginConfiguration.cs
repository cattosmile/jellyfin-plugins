using Jellyfin.Plugin.AudioDelay.Models;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.AudioDelay.Configuration;

/// <summary>
/// Persisted audio-delay profiles.
/// </summary>
public sealed class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the profiles locked for a series season and audio track.
    /// </summary>
    public List<AudioDelayProfile> Profiles { get; set; } = [];
}
