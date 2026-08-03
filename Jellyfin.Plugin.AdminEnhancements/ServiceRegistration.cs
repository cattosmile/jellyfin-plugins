using Jellyfin.Plugin.AdminEnhancements.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.AdminEnhancements;

/// <summary>
/// Registers the administrator enhancement services with Jellyfin.
/// </summary>
public sealed class ServiceRegistration : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHostedService<MediaDeletionService>();
    }
}
