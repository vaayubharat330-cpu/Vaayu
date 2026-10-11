const { haversineDistance } = require('./routingService');
const db = require('../db/database');

class ZoneService {
  findPickupZone(lat, lng) {
    const zones = (db.getZones ? db.getZones() : [])
      .filter(zone => Number.isFinite(Number(zone.centerLat)) && Number.isFinite(Number(zone.centerLng)) && Number(zone.radiusKm) > 0)
      .map(zone => ({ zone, distanceKm: haversineDistance(Number(lat), Number(lng), Number(zone.centerLat), Number(zone.centerLng)) }))
      .filter(item => item.distanceKm <= Number(item.zone.radiusKm))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    if (!zones.length) return null;
    const match = zones[0];
    return { id: match.zone.id, name: match.zone.name, status: match.zone.status, surgeMultiplier: Number(match.zone.surgeMultiplier) || 1, tollFee: Math.max(0, Number(match.zone.tollFee) || 0), distanceKm: Math.round(match.distanceKm * 100) / 100 };
  }
}

module.exports = { ZoneService, zoneService: new ZoneService() };
