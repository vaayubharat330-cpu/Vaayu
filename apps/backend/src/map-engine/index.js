const routingModule = require('./routing');
const geocodingModule = require('./geocoding');

const mapEngine = {
  routing: routingModule.routingService,
  geocoding: geocodingModule.locationSearchService,
  providers: {
    GoogleRoutingProvider: routingModule.GoogleRoutingProvider,
    OSRMProvider: routingModule.OSRMProvider,
    FallbackHaversineRoutingProvider: routingModule.FallbackHaversineRoutingProvider
  },
  getDiagnostics() {
    return {
      routeCache: this.routing.getCacheStats(),
      providerOrder: this.routing.providers.map(provider => provider.name),
      providerAvailability: {
        google: this.routing.googleProvider.isAvailable(),
        osrm: Boolean(this.routing.osrmProvider.baseUrl),
        offlineEstimate: true
      },
      geocodingLandmarkCount: this.geocoding.landmarks.length,
      geocodingProviders: ['local-landmarks', 'photon', 'nominatim']
    };
  }
};

module.exports = { mapEngine, ...routingModule, ...geocodingModule };
