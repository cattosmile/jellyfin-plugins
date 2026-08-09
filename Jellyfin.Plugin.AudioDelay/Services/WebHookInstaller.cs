using System.Text;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AudioDelay;

/// <summary>
/// Installs the small server-hosted script hook used by the web player.
/// </summary>
internal static class WebHookInstaller
{
    private const string Marker = "<!-- audio-delay:start -->";
    private const string Hook = "    <!-- audio-delay:start -->\n" +
                                 "    <script defer src=\"/AudioDelay/Script\"></script>\n" +
                                 "    <!-- audio-delay:end -->\n";

    private static readonly Action<ILogger, Exception?> WebPathMissing = LoggerMessage.Define(
        LogLevel.Warning,
        new EventId(1, nameof(WebPathMissing)),
        "Jellyfin did not provide a web shell path; the audio-delay web hook was not installed.");

    private static readonly Action<ILogger, string, Exception?> IndexMissing = LoggerMessage.Define<string>(
        LogLevel.Warning,
        new EventId(2, nameof(IndexMissing)),
        "Jellyfin web shell index was not found at {IndexPath}; the audio-delay web hook was not installed.");

    private static readonly Action<ILogger, string, Exception?> HeadTagMissing = LoggerMessage.Define<string>(
        LogLevel.Warning,
        new EventId(3, nameof(HeadTagMissing)),
        "Jellyfin web shell index at {IndexPath} has no closing head tag; the audio-delay web hook was not installed.");

    private static readonly Action<ILogger, string, Exception?> HookInstalled = LoggerMessage.Define<string>(
        LogLevel.Information,
        new EventId(4, nameof(HookInstalled)),
        "Installed the audio-delay web hook in {IndexPath}.");

    private static readonly Action<ILogger, string, Exception?> HookFailed = LoggerMessage.Define<string>(
        LogLevel.Warning,
        new EventId(5, nameof(HookFailed)),
        "Could not install the audio-delay web hook in {IndexPath}.");

    /// <summary>
    /// Adds the hook once to Jellyfin's hosted web shell.
    /// </summary>
    /// <param name="webPath">The web shell directory supplied by Jellyfin.</param>
    /// <param name="logger">The plugin logger.</param>
    public static void Apply(string? webPath, ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(webPath))
        {
            WebPathMissing(logger, null);
            return;
        }

        var indexPath = Path.Combine(webPath, "index.html");
        if (!File.Exists(indexPath))
        {
            IndexMissing(logger, indexPath, null);
            return;
        }

        try
        {
            var index = File.ReadAllText(indexPath, Encoding.UTF8);
            if (index.Contains(Marker, StringComparison.Ordinal))
            {
                return;
            }

            var headIndex = index.LastIndexOf("</head>", StringComparison.OrdinalIgnoreCase);
            if (headIndex < 0)
            {
                HeadTagMissing(logger, indexPath, null);
                return;
            }

            var updatedIndex = index.Insert(headIndex, Hook);
            var temporaryPath = indexPath + ".audio-delay.tmp";
            File.WriteAllText(temporaryPath, updatedIndex, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            File.Move(temporaryPath, indexPath, overwrite: true);
            HookInstalled(logger, indexPath, null);
        }
        catch (Exception exception)
        {
            HookFailed(logger, indexPath, exception);
        }
    }
}
