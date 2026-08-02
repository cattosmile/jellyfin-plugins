using System.Net.Mime;
using System.Net.Http.Json;
using Jellyfin.Plugin.AdministratorEnhancements.Configuration;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.AdministratorEnhancements.Api;

/// <summary>
/// Administrator-only endpoints for the administrator enhancements configuration page.
/// </summary>
[ApiController]
[Route("AdministratorEnhancements")]
[Produces(MediaTypeNames.Application.Json)]
public sealed class AdministratorEnhancementsController : ControllerBase
{
    private const string LibraryScanTaskKey = "RefreshLibrary";
    private static readonly HttpClient HttpClient = new();
    private static readonly object LibraryScanLock = new();

    private readonly ILibraryManager libraryManager;
    private readonly ITaskManager taskManager;

    /// <summary>
    /// Initializes a new instance of the <see cref="AdministratorEnhancementsController"/> class.
    /// </summary>
    /// <param name="libraryManager">The Jellyfin library manager.</param>
    /// <param name="taskManager">The Jellyfin scheduled task manager.</param>
    public AdministratorEnhancementsController(ILibraryManager libraryManager, ITaskManager taskManager)
    {
        this.libraryManager = libraryManager;
        this.taskManager = taskManager;
    }

    /// <summary>
    /// Tests whether Jellyfin can reach Seerr with the supplied settings.
    /// </summary>
    /// <param name="request">The connection settings to test.</param>
    /// <param name="cancellationToken">The request cancellation token.</param>
    /// <returns>A connection result without exposing the API key.</returns>
    [HttpPost("TestConnection")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(typeof(ConnectionTestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ConnectionTestResult), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ConnectionTestResult), StatusCodes.Status502BadGateway)]
    [ProducesResponseType(typeof(ConnectionTestResult), StatusCodes.Status504GatewayTimeout)]
    public async Task<ActionResult<ConnectionTestResult>> TestConnection(
        [FromBody] ConnectionTestRequest request,
        CancellationToken cancellationToken)
    {
        var configuration = Plugin.Instance?.Configuration;
        var seerrUrl = string.IsNullOrWhiteSpace(request.SeerrUrl)
            ? configuration?.SeerrUrl
            : request.SeerrUrl;
        var apiKey = string.IsNullOrWhiteSpace(request.SeerrApiKey)
            ? configuration?.SeerrApiKey
            : request.SeerrApiKey;

        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return BadRequest(new ConnectionTestResult(false, "Enter a Seerr API key first."));
        }

        if (!TryGetBaseUri(seerrUrl, out var baseUri))
        {
            return BadRequest(new ConnectionTestResult(false, "Enter a valid Seerr URL first."));
        }

        using var httpRequest = new HttpRequestMessage(
            HttpMethod.Get,
            new Uri(baseUri, "api/v1/status"));
        httpRequest.Headers.TryAddWithoutValidation("X-Api-Key", apiKey);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(GetTimeout(configuration));

        try
        {
            using var response = await HttpClient.SendAsync(httpRequest, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var message = response.StatusCode == System.Net.HttpStatusCode.Unauthorized
                    ? "Seerr rejected the API key."
                    : $"Seerr returned HTTP {(int)response.StatusCode}.";
                return StatusCode(
                    StatusCodes.Status502BadGateway,
                    new ConnectionTestResult(false, message));
            }

            var status = await response.Content
                .ReadFromJsonAsync<SeerrStatus>(cancellationToken: timeout.Token)
                .ConfigureAwait(false);
            var versionMessage = string.IsNullOrWhiteSpace(status?.Version)
                ? "Connection to Seerr is working."
                : $"Connection to Seerr is working (version {status.Version}).";
            return Ok(new ConnectionTestResult(true, versionMessage));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return StatusCode(
                StatusCodes.Status504GatewayTimeout,
                new ConnectionTestResult(false, "The Seerr connection timed out."));
        }
        catch (HttpRequestException)
        {
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new ConnectionTestResult(false, "Jellyfin could not reach Seerr."));
        }
    }

    /// <summary>
    /// Gets the state of Jellyfin's normal library scan task.
    /// </summary>
    /// <returns>The current library scan state.</returns>
    [HttpGet("ScanStatus")]
    [Authorize(Policy = Policies.FirstTimeSetupOrDefault)]
    [ProducesResponseType(typeof(LibraryScanStatus), StatusCodes.Status200OK)]
    public ActionResult<LibraryScanStatus> GetScanStatus()
    {
        lock (LibraryScanLock)
        {
            return Ok(ReadScanStatus());
        }
    }

    /// <summary>
    /// Queues Jellyfin's normal full library scan.
    /// </summary>
    /// <returns>The queued library scan state.</returns>
    [HttpPost("ScanLibraries")]
    [Authorize(Policy = Policies.FirstTimeSetupOrDefault)]
    [ProducesResponseType(typeof(LibraryScanStatus), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(LibraryScanStatus), StatusCodes.Status200OK)]
    public ActionResult<LibraryScanStatus> ScanLibraries()
    {
        lock (LibraryScanLock)
        {
            var currentStatus = ReadScanStatus();
            if (currentStatus.IsRunning)
            {
                return Ok(currentStatus);
            }

            libraryManager.QueueLibraryScan();
            return Accepted(new LibraryScanStatus(
                IsRunning: true,
                ProgressPercentage: null,
                State: "Queued",
                Message: "Library scan queued."));
        }
    }

    private LibraryScanStatus ReadScanStatus()
    {
        var task = taskManager.ScheduledTasks
            .Select(ScheduledTaskHelpers.GetTaskInfo)
            .FirstOrDefault(scheduledTask =>
                string.Equals(scheduledTask.Key, LibraryScanTaskKey, StringComparison.OrdinalIgnoreCase));

        if (task is null)
        {
            return new LibraryScanStatus(
                IsRunning: false,
                ProgressPercentage: null,
                State: "Unavailable",
                Message: "Jellyfin's library scan task is unavailable.");
        }

        var isRunning = task.State is TaskState.Running or TaskState.Cancelling;
        return new LibraryScanStatus(
            IsRunning: isRunning,
            ProgressPercentage: isRunning ? task.CurrentProgressPercentage : null,
            State: task.State.ToString(),
            Message: isRunning ? "Scanning media library." : "Ready to scan.");
    }

    private static bool TryGetBaseUri(string? configuredUrl, out Uri baseUri)
    {
        var value = (configuredUrl ?? string.Empty).Trim();
        if (!value.EndsWith('/'))
        {
            value += "/";
        }

        return Uri.TryCreate(value, UriKind.Absolute, out baseUri!) &&
            (baseUri.Scheme == Uri.UriSchemeHttp || baseUri.Scheme == Uri.UriSchemeHttps);
    }

    private static TimeSpan GetTimeout(PluginConfiguration? configuration)
    {
        return TimeSpan.FromSeconds(Math.Clamp(configuration?.RequestTimeoutSeconds ?? 15, 5, 120));
    }

    private sealed class SeerrStatus
    {
        public string? Version { get; set; }
    }
}

/// <summary>
/// Settings supplied to the administrator-only Seerr connection test.
/// </summary>
public sealed class ConnectionTestRequest
{
    /// <summary>
    /// Gets or sets the Seerr URL.
    /// </summary>
    public string? SeerrUrl { get; set; }

    /// <summary>
    /// Gets or sets the Seerr API key.
    /// </summary>
    public string? SeerrApiKey { get; set; }
}

/// <summary>
/// Result returned by the Seerr connection test.
/// </summary>
public sealed record ConnectionTestResult(bool Connected, string Message);

/// <summary>
/// The current state of Jellyfin's library scan task.
/// </summary>
public sealed record LibraryScanStatus(
    bool IsRunning,
    double? ProgressPercentage,
    string State,
    string Message);
