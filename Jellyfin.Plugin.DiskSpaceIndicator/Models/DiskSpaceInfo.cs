namespace Jellyfin.Plugin.DiskSpaceIndicator.Models;

/// <summary>
/// A point-in-time filesystem usage snapshot.
/// </summary>
public sealed class DiskSpaceInfo
{
    /// <summary>
    /// Gets or sets the path used to select the volume.
    /// </summary>
    public string Path { get; set; } = "/";

    /// <summary>
    /// Gets or sets the total capacity in bytes.
    /// </summary>
    public long TotalBytes { get; set; }

    /// <summary>
    /// Gets or sets the used capacity in bytes.
    /// </summary>
    public long UsedBytes { get; set; }

    /// <summary>
    /// Gets or sets the available capacity in bytes.
    /// </summary>
    public long FreeBytes { get; set; }

    /// <summary>
    /// Gets or sets the used percentage.
    /// </summary>
    public double UsedPercentage { get; set; }
}
