using System.Net.Mime;
using System.Text;
using Jellyfin.Plugin.AudioDelay.Models;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.AudioDelay.Api;

/// <summary>
/// Serves the player extension and persists locked audio-delay profiles.
/// </summary>
[ApiController]
[Route("AudioDelay")]
[Produces(MediaTypeNames.Application.Json)]
[Authorize(Policy = Policies.FirstTimeSetupOrDefault)]
public sealed class AudioDelayController : ControllerBase
{
    private const int MinimumSeasonNumber = 0;
    private const int MaximumSeasonNumber = 1000;
    private const int MaximumDelayMilliseconds = 10000;
    private const int MaximumTrackKeyLength = 300;
    private const int MaximumTrackLabelLength = 500;
    private const string ScriptResourceName = "Jellyfin.Plugin.AudioDelay.Web.audio-delay.js";

    /// <summary>
    /// Gets a locked profile for the requested series season and audio track.
    /// </summary>
    /// <param name="seriesId">The series identifier.</param>
    /// <param name="seasonNumber">The season number.</param>
    /// <param name="trackKey">The normalized track key.</param>
    /// <returns>The locked profile, or <see langword="null" />.</returns>
    [HttpGet("Profile")]
    [ProducesResponseType(typeof(AudioDelayProfile), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public ActionResult<AudioDelayProfile?> GetProfile(
        [FromQuery] Guid seriesId,
        [FromQuery] int seasonNumber,
        [FromQuery] string? trackKey)
    {
        if (!TryValidateKey(seriesId, seasonNumber, trackKey, out var error))
        {
            return BadRequest(error);
        }

        return Ok(Plugin.Instance?.FindProfile(seriesId, seasonNumber, trackKey!));
    }

    /// <summary>
    /// Saves a locked profile for the requested series season and audio track.
    /// </summary>
    /// <param name="profile">The profile to save.</param>
    /// <returns>The persisted profile.</returns>
    [HttpPut("Profile")]
    [ProducesResponseType(typeof(AudioDelayProfile), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public ActionResult<AudioDelayProfile> SaveProfile([FromBody] AudioDelayProfile profile)
    {
        if (!TryValidateProfile(profile, out var error))
        {
            return BadRequest(error);
        }

        var plugin = Plugin.Instance;
        return plugin is null
            ? Problem("The Audio Delay plugin is not initialized.")
            : Ok(plugin.SaveProfile(profile));
    }

    /// <summary>
    /// Removes a locked profile.
    /// </summary>
    /// <param name="seriesId">The series identifier.</param>
    /// <param name="seasonNumber">The season number.</param>
    /// <param name="trackKey">The normalized track key.</param>
    /// <returns>No content.</returns>
    [HttpDelete("Profile")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public IActionResult DeleteProfile(
        [FromQuery] Guid seriesId,
        [FromQuery] int seasonNumber,
        [FromQuery] string? trackKey)
    {
        if (!TryValidateKey(seriesId, seasonNumber, trackKey, out var error))
        {
            return BadRequest(error);
        }

        Plugin.Instance?.DeleteProfile(seriesId, seasonNumber, trackKey!);
        return NoContent();
    }

    /// <summary>
    /// Serves the small web client extension loaded by Jellyfin's web shell.
    /// </summary>
    /// <returns>The audio-delay script.</returns>
    [HttpGet("Script")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ContentResult GetScript()
    {
        using var stream = typeof(Plugin).Assembly.GetManifestResourceStream(ScriptResourceName);
        if (stream is null)
        {
            throw new InvalidOperationException($"Embedded resource '{ScriptResourceName}' was not found.");
        }

        using var reader = new StreamReader(stream, Encoding.UTF8);
        return Content(reader.ReadToEnd(), "application/javascript; charset=utf-8");
    }

    private static bool TryValidateProfile(AudioDelayProfile? profile, out string error)
    {
        if (profile is null)
        {
            error = "A profile is required.";
            return false;
        }

        return TryValidateKey(profile.SeriesId, profile.SeasonNumber, profile.TrackKey, out error) &&
            ValidateLength(profile.TrackLabel, MaximumTrackLabelLength, "TrackLabel", out error) &&
            ValidateDelay(profile.DelayMilliseconds, out error);
    }

    private static bool TryValidateKey(Guid seriesId, int seasonNumber, string? trackKey, out string error)
    {
        if (seriesId == Guid.Empty)
        {
            error = "A series identifier is required.";
            return false;
        }

        if (seasonNumber is < MinimumSeasonNumber or > MaximumSeasonNumber)
        {
            error = "The season number is outside the supported range.";
            return false;
        }

        return ValidateLength(trackKey, MaximumTrackKeyLength, "TrackKey", out error);
    }

    private static bool ValidateLength(string? value, int maximumLength, string name, out string error)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength)
        {
            error = $"{name} must contain between 1 and {maximumLength} characters.";
            return false;
        }

        error = string.Empty;
        return true;
    }

    private static bool ValidateDelay(int delayMilliseconds, out string error)
    {
        if (delayMilliseconds is < -MaximumDelayMilliseconds or > MaximumDelayMilliseconds)
        {
            error = $"Delay must be between {-MaximumDelayMilliseconds} and {MaximumDelayMilliseconds} milliseconds.";
            return false;
        }

        error = string.Empty;
        return true;
    }
}
