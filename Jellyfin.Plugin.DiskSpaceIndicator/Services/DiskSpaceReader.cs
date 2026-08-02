using System.IO;
using Jellyfin.Plugin.DiskSpaceIndicator.Models;

namespace Jellyfin.Plugin.DiskSpaceIndicator.Services;

/// <summary>
/// Reads usage for the volume containing the configured path.
/// </summary>
public static class DiskSpaceReader
{
    /// <summary>
    /// Reads a fresh filesystem snapshot.
    /// </summary>
    /// <param name="path">A path on the volume to inspect.</param>
    /// <returns>The current usage snapshot.</returns>
    public static DiskSpaceInfo Read(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        var drive = new DriveInfo(path);

        var totalBytes = drive.TotalSize;
        var freeBytes = Math.Clamp(drive.AvailableFreeSpace, 0, totalBytes);
        var usedBytes = totalBytes - freeBytes;
        var usedPercentage = totalBytes == 0
            ? 0
            : Math.Round(usedBytes * 100d / totalBytes, 1, MidpointRounding.AwayFromZero);

        return new DiskSpaceInfo
        {
            Path = drive.RootDirectory.FullName,
            TotalBytes = totalBytes,
            UsedBytes = usedBytes,
            FreeBytes = freeBytes,
            UsedPercentage = usedPercentage
        };
    }
}
