namespace Jellyfin.Plugin.AudioDelay.Models;

/// <summary>
/// A delay applied to one normalized audio track within one series season.
/// </summary>
public sealed class AudioDelayProfile
{
    /// <summary>
    /// Gets or sets the series identifier.
    /// </summary>
    public Guid SeriesId { get; set; }

    /// <summary>
    /// Gets or sets the season number.
    /// </summary>
    public int SeasonNumber { get; set; }

    /// <summary>
    /// Gets or sets the normalized audio-track key.
    /// </summary>
    public string TrackKey { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the user-facing audio-track label.
    /// </summary>
    public string TrackLabel { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the delay in milliseconds. Positive values delay audio.
    /// </summary>
    public int DelayMilliseconds { get; set; }
}
