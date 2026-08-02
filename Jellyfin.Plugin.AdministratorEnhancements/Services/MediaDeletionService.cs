using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Jellyfin.Plugin.AdministratorEnhancements.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AdministratorEnhancements.Services;

/// <summary>
/// Observes Jellyfin item removals and synchronizes matching Seerr records.
/// </summary>
public sealed partial class MediaDeletionService : IHostedService
{
    private const int RequestPageSize = 100;
    private static readonly HttpClient HttpClient = new();
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly ILibraryManager libraryManager;
    private readonly ILogger<MediaDeletionService> logger;
    private readonly ConcurrentDictionary<Guid, byte> inFlight = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="MediaDeletionService"/> class.
    /// </summary>
    /// <param name="libraryManager">The Jellyfin library manager.</param>
    /// <param name="logger">The service logger.</param>
    public MediaDeletionService(ILibraryManager libraryManager, ILogger<MediaDeletionService> logger)
    {
        this.libraryManager = libraryManager;
        this.logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        libraryManager.ItemRemoved += OnItemRemoved;
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        libraryManager.ItemRemoved -= OnItemRemoved;
        return Task.CompletedTask;
    }

    private async void OnItemRemoved(object? sender, ItemChangeEventArgs eventArgs)
    {
        if (eventArgs.Item is not Movie && eventArgs.Item is not Series)
        {
            return;
        }

        var deletedMedia = DeletedMedia.From(eventArgs.Item);
        if (!inFlight.TryAdd(deletedMedia.JellyfinId, 0))
        {
            return;
        }

        try
        {
            await SynchronizeAsync(deletedMedia).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            LogSynchronizationFailed(exception, deletedMedia.Name, deletedMedia.JellyfinId);
        }
        finally
        {
            inFlight.TryRemove(deletedMedia.JellyfinId, out _);
        }
    }

    private async Task SynchronizeAsync(DeletedMedia deletedMedia)
    {
        var configuration = Plugin.Instance?.Configuration;
        if (configuration is null || !configuration.DeleteSynchronizationEnabled)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(configuration.SeerrApiKey))
        {
            LogMissingApiKey();
            return;
        }

        if (!TryGetSeerrBaseUri(configuration.SeerrUrl, out var baseUri))
        {
            LogInvalidSeerrUrl(configuration.SeerrUrl);
            return;
        }

        var requests = await FindMatchingRequestsAsync(baseUri, configuration, deletedMedia).ConfigureAwait(false);
        if (requests.Count == 0)
        {
            LogNoMatchingRequest(deletedMedia.Name, deletedMedia.JellyfinId);
            return;
        }

        var mediaRecords = requests
            .Where(request => request.Media is not null)
            .Select(request => request.Media!)
            .DistinctBy(media => media.Id)
            .ToList();
        var requestIds = requests.Select(request => request.Id).Distinct().ToList();

        if (configuration.DryRun)
        {
            LogDryRun(deletedMedia.Name, mediaRecords.Count, requestIds.Count);
            return;
        }

        var remoteRemovalSucceeded = true;
        if (configuration.RemoveFromDownloadManager)
        {
            foreach (var media in mediaRecords)
            {
                remoteRemovalSucceeded &= await DeleteMediaFileAsync(
                    baseUri,
                    configuration,
                    media.Id,
                    is4k: false,
                    deletedMedia.Name).ConfigureAwait(false);

                if (media.ExternalServiceId4k is not null)
                {
                    remoteRemovalSucceeded &= await DeleteMediaFileAsync(
                        baseUri,
                        configuration,
                        media.Id,
                        is4k: true,
                        deletedMedia.Name).ConfigureAwait(false);
                }
            }
        }

        if (!remoteRemovalSucceeded)
        {
            LogRemoteRemovalFailed(deletedMedia.Name);
            return;
        }

        if (configuration.DeleteSeerrRequests)
        {
            foreach (var requestId in requestIds)
            {
                await DeleteRequestAsync(baseUri, configuration, requestId, deletedMedia.Name).ConfigureAwait(false);
            }
        }
    }

    private async Task<List<SeerrRequest>> FindMatchingRequestsAsync(
        Uri baseUri,
        PluginConfiguration configuration,
        DeletedMedia deletedMedia)
    {
        var allRequests = new List<SeerrRequest>();
        var skip = 0;

        for (var page = 0; page < 100; page++)
        {
            var pageResult = await GetJsonAsync<SeerrRequestPage>(
                new Uri(baseUri, $"api/v1/request?take={RequestPageSize}&skip={skip}"),
                configuration,
                "request list").ConfigureAwait(false);

            if (pageResult is null || pageResult.Results.Count == 0)
            {
                break;
            }

            allRequests.AddRange(pageResult.Results);
            var totalPages = pageResult.PageInfo?.Pages ?? 1;
            if (page + 1 >= totalPages || pageResult.Results.Count < RequestPageSize)
            {
                break;
            }

            skip += RequestPageSize;
        }

        var jellyfinId = deletedMedia.JellyfinId.ToString("N");
        var exactMatches = allRequests
            .Where(request => IsMatchingMediaType(request.Media, deletedMedia.MediaType))
            .Where(request => string.Equals(NormalizeId(request.Media?.JellyfinMediaId), jellyfinId, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (exactMatches.Count > 0)
        {
            return exactMatches;
        }

        var providerMatches = allRequests
            .Where(request => IsMatchingMediaType(request.Media, deletedMedia.MediaType))
            .Where(request => MatchesProviderId(request.Media, deletedMedia))
            .ToList();

        return providerMatches
            .Select(request => request.Media?.Id)
            .Distinct()
            .Count() == 1
            ? providerMatches
            : [];
    }

    private async Task<bool> DeleteMediaFileAsync(
        Uri baseUri,
        PluginConfiguration configuration,
        int mediaId,
        bool is4k,
        string itemName)
    {
        var suffix = is4k ? "?is4k=true" : string.Empty;
        return await SendDeleteAsync(
            new Uri(baseUri, $"api/v1/media/{mediaId}/file{suffix}"),
            configuration,
            $"remove {(is4k ? "4K " : string.Empty)}Radarr/Sonarr file for {itemName}").ConfigureAwait(false);
    }

    private async Task<bool> DeleteRequestAsync(
        Uri baseUri,
        PluginConfiguration configuration,
        int requestId,
        string itemName)
    {
        return await SendDeleteAsync(
            new Uri(baseUri, $"api/v1/request/{requestId}"),
            configuration,
            $"delete Seerr request for {itemName}").ConfigureAwait(false);
    }

    private async Task<bool> SendDeleteAsync(Uri uri, PluginConfiguration configuration, string operation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, uri);
        request.Headers.TryAddWithoutValidation("X-Api-Key", configuration.SeerrApiKey);
        using var cancellation = new CancellationTokenSource(GetTimeout(configuration));
        using var response = await HttpClient.SendAsync(request, cancellation.Token).ConfigureAwait(false);

        if (response.IsSuccessStatusCode || response.StatusCode == HttpStatusCode.NotFound)
        {
            LogOperationSucceeded(response.StatusCode, operation);
            return true;
        }

        LogOperationFailed(response.StatusCode, operation);
        return false;
    }

    private async Task<T?> GetJsonAsync<T>(Uri uri, PluginConfiguration configuration, string operation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.TryAddWithoutValidation("X-Api-Key", configuration.SeerrApiKey);
        using var cancellation = new CancellationTokenSource(GetTimeout(configuration));
        using var response = await HttpClient.SendAsync(request, cancellation.Token).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        LogRequestSucceeded(operation);
        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellation.Token).ConfigureAwait(false);
    }

    [LoggerMessage(
        EventId = 1000,
        Level = LogLevel.Error,
        Message = "Administrator Enhancements could not synchronize deleted Jellyfin item {ItemName} ({ItemId})")]
    private partial void LogSynchronizationFailed(Exception exception, string itemName, Guid itemId);

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Warning,
        Message = "Deleted item synchronization is enabled, but no Seerr API key is configured")]
    private partial void LogMissingApiKey();

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Warning,
        Message = "The configured Seerr URL is invalid: {SeerrUrl}")]
    private partial void LogInvalidSeerrUrl(string seerrUrl);

    [LoggerMessage(
        EventId = 1003,
        Level = LogLevel.Information,
        Message = "No Seerr request matched deleted Jellyfin item {ItemName} ({ItemId}); no remote deletion was attempted")]
    private partial void LogNoMatchingRequest(string itemName, Guid itemId);

    [LoggerMessage(
        EventId = 1004,
        Level = LogLevel.Warning,
        Message = "[DRY RUN] Deleted {ItemName}: would remove {MediaCount} Seerr media record(s) from Radarr/Sonarr and delete {RequestCount} Seerr request(s)")]
    private partial void LogDryRun(string itemName, int mediaCount, int requestCount);

    [LoggerMessage(
        EventId = 1005,
        Level = LogLevel.Warning,
        Message = "Keeping Seerr requests for deleted {ItemName} because at least one Radarr/Sonarr removal failed")]
    private partial void LogRemoteRemovalFailed(string itemName);

    [LoggerMessage(
        EventId = 1006,
        Level = LogLevel.Information,
        Message = "Seerr operation succeeded ({StatusCode}): {Operation}")]
    private partial void LogOperationSucceeded(HttpStatusCode statusCode, string operation);

    [LoggerMessage(
        EventId = 1007,
        Level = LogLevel.Warning,
        Message = "Seerr operation failed ({StatusCode}): {Operation}")]
    private partial void LogOperationFailed(HttpStatusCode statusCode, string operation);

    [LoggerMessage(
        EventId = 1008,
        Level = LogLevel.Debug,
        Message = "Seerr operation succeeded: {Operation}")]
    private partial void LogRequestSucceeded(string operation);

    private static bool TryGetSeerrBaseUri(string? configuredUrl, out Uri baseUri)
    {
        var value = (configuredUrl ?? string.Empty).Trim();
        if (!value.EndsWith('/'))
        {
            value += "/";
        }

        return Uri.TryCreate(value, UriKind.Absolute, out baseUri!) &&
            (baseUri.Scheme == Uri.UriSchemeHttp || baseUri.Scheme == Uri.UriSchemeHttps);
    }

    private static bool IsMatchingMediaType(SeerrMedia? media, string mediaType)
    {
        return media is not null && string.Equals(media.MediaType, mediaType, StringComparison.OrdinalIgnoreCase);
    }

    private static bool MatchesProviderId(SeerrMedia? media, DeletedMedia deletedMedia)
    {
        if (media is null)
        {
            return false;
        }

        return deletedMedia.TmdbId is not null && media.TmdbId == deletedMedia.TmdbId ||
            deletedMedia.TvdbId is not null && media.TvdbId == deletedMedia.TvdbId;
    }

    private static string? NormalizeId(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Replace("-", string.Empty, StringComparison.Ordinal);
    }

    private static TimeSpan GetTimeout(PluginConfiguration configuration)
    {
        return TimeSpan.FromSeconds(Math.Clamp(configuration.RequestTimeoutSeconds, 5, 120));
    }

    private sealed record DeletedMedia(Guid JellyfinId, string Name, string MediaType, int? TmdbId, int? TvdbId)
    {
        public static DeletedMedia From(BaseItem item)
        {
            item.ProviderIds.TryGetValue("Tmdb", out var tmdbIdValue);
            item.ProviderIds.TryGetValue("Tvdb", out var tvdbIdValue);

            return new DeletedMedia(
                item.Id,
                item.Name ?? "Unnamed item",
                item is Series ? "tv" : "movie",
                int.TryParse(tmdbIdValue, out var tmdbId) ? tmdbId : null,
                int.TryParse(tvdbIdValue, out var tvdbId) ? tvdbId : null);
        }
    }

    private sealed class SeerrRequestPage
    {
        public SeerrPageInfo? PageInfo { get; set; }

        public List<SeerrRequest> Results { get; set; } = [];
    }

    private sealed class SeerrPageInfo
    {
        public int Pages { get; set; }
    }

    private sealed class SeerrRequest
    {
        public int Id { get; set; }

        public SeerrMedia? Media { get; set; }
    }

    private sealed class SeerrMedia
    {
        public int Id { get; set; }

        public string? MediaType { get; set; }

        public string? JellyfinMediaId { get; set; }

        public int? TmdbId { get; set; }

        public int? TvdbId { get; set; }

        public int? ExternalServiceId4k { get; set; }
    }
}
