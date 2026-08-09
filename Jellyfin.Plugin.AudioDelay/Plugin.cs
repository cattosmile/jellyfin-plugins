using Jellyfin.Plugin.AudioDelay.Configuration;
using Jellyfin.Plugin.AudioDelay.Models;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AudioDelay;

/// <summary>
/// Adds per-track audio delay controls to Jellyfin's web player.
/// </summary>
public sealed class Plugin : BasePlugin<PluginConfiguration>
{
    /// <summary>
    /// Stable plugin identifier.
    /// </summary>
    public static readonly Guid PluginId = Guid.Parse("5b4b4e4f-8f76-4a5b-9e80-2d3c3d0fcb18");

    private readonly object profileLock = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">The Jellyfin application paths.</param>
    /// <param name="xmlSerializer">The Jellyfin XML serializer.</param>
    /// <param name="logger">The plugin logger.</param>
    public Plugin(
        IApplicationPaths applicationPaths,
        IXmlSerializer xmlSerializer,
        ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        WebHookInstaller.Apply(applicationPaths.WebPath, logger);
    }

    /// <summary>
    /// Gets the active plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Audio Delay";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <summary>
    /// Finds a profile matching one series, season and track.
    /// </summary>
    /// <param name="seriesId">The series identifier.</param>
    /// <param name="seasonNumber">The season number.</param>
    /// <param name="trackKey">The normalized track key.</param>
    /// <returns>A copy of the matching profile, if one exists.</returns>
    public AudioDelayProfile? FindProfile(Guid seriesId, int seasonNumber, string trackKey)
    {
        lock (profileLock)
        {
            var profile = Configuration.Profiles.FirstOrDefault(item => IsMatch(item, seriesId, seasonNumber, trackKey));
            return profile is null ? null : Clone(profile);
        }
    }

    /// <summary>
    /// Adds or replaces a locked profile and persists the configuration.
    /// </summary>
    /// <param name="profile">The profile to persist.</param>
    /// <returns>A copy of the persisted profile.</returns>
    public AudioDelayProfile SaveProfile(AudioDelayProfile profile)
    {
        lock (profileLock)
        {
            Configuration.Profiles ??= [];
            var existingIndex = Configuration.Profiles.FindIndex(item =>
                IsMatch(item, profile.SeriesId, profile.SeasonNumber, profile.TrackKey));

            var savedProfile = Clone(profile);
            if (existingIndex >= 0)
            {
                Configuration.Profiles[existingIndex] = savedProfile;
            }
            else
            {
                Configuration.Profiles.Add(savedProfile);
            }

            SaveConfiguration();
            return Clone(savedProfile);
        }
    }

    /// <summary>
    /// Removes a locked profile.
    /// </summary>
    /// <param name="seriesId">The series identifier.</param>
    /// <param name="seasonNumber">The season number.</param>
    /// <param name="trackKey">The normalized track key.</param>
    /// <returns><see langword="true" /> when a profile was removed.</returns>
    public bool DeleteProfile(Guid seriesId, int seasonNumber, string trackKey)
    {
        lock (profileLock)
        {
            var removed = Configuration.Profiles.RemoveAll(item => IsMatch(item, seriesId, seasonNumber, trackKey)) > 0;
            if (removed)
            {
                SaveConfiguration();
            }

            return removed;
        }
    }

    private static bool IsMatch(AudioDelayProfile profile, Guid seriesId, int seasonNumber, string trackKey)
    {
        return profile.SeriesId == seriesId &&
            profile.SeasonNumber == seasonNumber &&
            string.Equals(profile.TrackKey, trackKey, StringComparison.OrdinalIgnoreCase);
    }

    private static AudioDelayProfile Clone(AudioDelayProfile profile)
    {
        return new AudioDelayProfile
        {
            SeriesId = profile.SeriesId,
            SeasonNumber = profile.SeasonNumber,
            TrackKey = profile.TrackKey,
            TrackLabel = profile.TrackLabel,
            DelayMilliseconds = profile.DelayMilliseconds
        };
    }
}
