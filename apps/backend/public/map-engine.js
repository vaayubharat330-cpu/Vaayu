(function attachVaayuMapEngine(global) {
  const apiPath = '/api/routing/calculate';

  function normalizePoints(points) {
    return (points || []).map(point => Array.isArray(point)
      ? { lat: Number(point[0]), lng: Number(point[1]) }
      : { lat: Number(point.lat), lng: Number(point.lng) });
  }

  async function calculateRoute(points, options = {}) {
    const waypoints = normalizePoints(points);
    if (waypoints.length < 2 || waypoints.some(point =>
      !Number.isFinite(point.lat) || !Number.isFinite(point.lng) ||
      Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) {
      throw new Error('Choose at least two valid map points to calculate a route.');
    }

    const response = await fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pickupLat: waypoints[0].lat,
        pickupLng: waypoints[0].lng,
        dropLat: waypoints[waypoints.length - 1].lat,
        dropLng: waypoints[waypoints.length - 1].lng,
        intermediateStops: waypoints.slice(1, -1),
        vehicleId: options.vehicleId,
        isOutstation: options.isOutstation
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Map routing is unavailable.');
    return result;
  }

  function renderGeometry(map, points, options = {}) {
    if (!map || !global.L || !Array.isArray(points) || points.length < 2) return null;
    const color = options.isDegraded ? (options.degradedColor || '#f59e0b') : (options.color || '#10b981');
    const line = global.L.polyline(points, {
      color,
      weight: options.weight || 5,
      opacity: options.opacity ?? 0.9,
      dashArray: options.isDegraded ? '8, 7' : (options.dashArray || null),
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
    if (options.fitBounds !== false) {
      map.fitBounds(line.getBounds(), { padding: options.padding || [40, 40], maxZoom: options.maxZoom || 16 });
    }
    return line;
  }

  async function drawRoute(map, points, options = {}) {
    const route = await calculateRoute(points, options);
    const geometry = route.routePoints?.length >= 2
      ? route.routePoints
      : normalizePoints(points).map(point => [point.lat, point.lng]);
    return { route, line: renderGeometry(map, geometry, { ...options, isDegraded: route.isDegraded }) };
  }

  global.VaayuMapEngine = Object.freeze({ calculateRoute, drawRoute, renderGeometry });
})(window);
