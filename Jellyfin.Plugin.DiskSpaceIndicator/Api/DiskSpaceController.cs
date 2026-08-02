using System.Net.Mime;
using System.Text;
using Jellyfin.Plugin.DiskSpaceIndicator.Models;
using Jellyfin.Plugin.DiskSpaceIndicator.Services;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.DiskSpaceIndicator.Api;

/// <summary>
/// Authenticated disk-space endpoints used by the Jellyfin web indicator.
/// </summary>
[ApiController]
[Authorize(Policy = Policies.FirstTimeSetupOrDefault)]
[Route("DiskSpace")]
[Produces(MediaTypeNames.Application.Json)]
public sealed class DiskSpaceController : ControllerBase
{
    private const string ScriptResourceName = "Jellyfin.Plugin.DiskSpaceIndicator.Web.disk-space-indicator.js";

    /// <summary>
    /// Gets the current usage of the configured filesystem volume.
    /// </summary>
    /// <returns>The current disk-space snapshot.</returns>
    [HttpGet("Info")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status500InternalServerError)]
    public ActionResult<DiskSpaceInfo> GetInfo()
    {
        var configuration = Plugin.Instance?.Configuration;
        var rootPath = string.IsNullOrWhiteSpace(configuration?.RootPath) ? "/" : configuration.RootPath;

        try
        {
            return Ok(DiskSpaceReader.Read(rootPath));
        }
        catch (Exception exception)
        {
            return Problem(
                detail: $"Unable to read disk space for '{rootPath}': {exception.Message}",
                statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    /// <summary>
    /// Serves the small web client extension loaded by Jellyfin's web shell.
    /// </summary>
    /// <returns>The indicator script.</returns>
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
}
