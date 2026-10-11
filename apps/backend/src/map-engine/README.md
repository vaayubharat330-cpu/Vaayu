# VAAYU Map Engine

This directory owns location search, reverse geocoding, road routing, route geometry, distance, and ETA calculation. Portal and business code should call this boundary rather than implement map logic themselves.

## Modules

- `routing.js` contains provider adapters, route validation, provider fallback, route caching, and ETA logic.
- `geocoding.js` contains local landmark search, external geocoder adapters, address confidence, and reverse geocoding.
- `index.js` exports the shared `mapEngine` facade and lightweight diagnostics.
- `../services/routingService.js` and `../services/locationSearchService.js` are compatibility shims for older imports.

## Current route quality

Google Directions and OSRM responses include road geometry. The offline fallback is a straight-line estimate with a road-distance multiplier; it is marked `isDegraded` and `routeQuality: STRAIGHT_LINE_ESTIMATE`. It must not be presented as a street-by-street route. Google route geometry is decoded from the provider's overview polyline.

## Improvement boundary

Add routing and geocoding providers here, behind the existing provider contracts. Preserve the response fields used by booking, dispatch, ETA, and maps. Keep confidence and degraded quality explicit so a synthesized address or offline estimate is never described as rooftop-level or road-accurate. Prefer a managed/local routing deployment with vehicle profiles and traffic-aware ETA before using this for production dispatch or fare guarantees.

## Research notes

Public help material from established ride apps highlights useful customer outcomes such as explicit pickup-pin confirmation and predictable handling of intermediate stops. VAAYU should implement those outcomes with its own interaction design and domain logic rather than copying another app's layouts, assets, wording, or proprietary implementation.

The open OSRM interface documents independent capabilities for route alternatives and steps, road snapping (`nearest`), travel-time matrices (`table`), and GPS trace matching (`match`). Those map cleanly to future VAAYU interfaces for route choice, pickup quality, dispatch ranking, and driver GPS correction. MapLibre is an open-source vector-map renderer; it can provide a separate browser/native rendering layer, while map data and routing remain provider-independent. The public OSMF Nominatim endpoint has strict capacity limits, including a maximum of one request per second, so it is not a scalable production autocomplete backend.

References: [OSRM HTTP API](https://project-osrm.org/docs/v26.5.0/http), [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/), [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), and [Uber pickup pin and confirmation help](https://help.uber.com/en-GB/riders/article/what-are-suggested-pickup-location?nodeId=9edf05bf-ac3a-4cf8-b08e-76e9ca767f7f).

The local raster basemap uses the standard OSM tile endpoint with visible attribution. OSM data is open, but the community tile servers are capacity-limited and best-effort; production should select a tile host or self-hosting setup appropriate to expected traffic and licensing needs. See the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
