const fs = require('fs');
const path = require('path');
const { PostgresPool } = require('./postgresClient');
const { metricsService } = require('../services/metricsService');
const { orderIdService } = require('../services/orderIdService');

const DB_FILE = path.join(__dirname, 'vaayu_store.json');

/**
 * VAAYU Milestone 6 Phase 6.1: Persistence Boundary Abstraction
 *
 * Provides:
 * 1. DatabaseRepository (Abstract Class Boundary)
 * 2. JsonDatabaseRepository (Preserves existing JSON persistence)
 * 3. PostgresDatabaseRepository (Durable PostgreSQL transactional persistence with optimistic concurrency & audit logs)
 */

class DatabaseRepository {
  async getUserByPhone(phone) { throw new Error('Not implemented'); }
  async createUser(userData) { throw new Error('Not implemented'); }
  async getCustomers() { throw new Error('Not implemented'); }
  async getDrivers() { throw new Error('Not implemented'); }
  async getVehicles() { throw new Error('Not implemented'); }
  async getTrips() { throw new Error('Not implemented'); }
  async getTripById(tripId) { throw new Error('Not implemented'); }
  async createTrip(tripData) { throw new Error('Not implemented'); }
  async saveTrip(tripData) { throw new Error('Not implemented'); }
  async updateTripStatus(tripId, status) { throw new Error('Not implemented'); }
  async transitionTripState(tripId, expectedVersion, nextState, actor, reason, idempotencyKey, metadata) { throw new Error('Not implemented'); }
  async getAuditLogs(tripId) { throw new Error('Not implemented'); }
  async getAdminAnalytics() { throw new Error('Not implemented'); }
}

// 1. JSON Database Repository Adapter (Preserves vaayu_store.json)
class JsonDatabaseRepository extends DatabaseRepository {
  constructor(readDbFn, writeDbFn, defaultDataObj) {
    super();
    this.readDb = readDbFn;
    this.writeDb = writeDbFn;
    this.defaultData = defaultDataObj;
  }

  getUserByPhone(phone, role = null) {
    const db = this.readDb();
    if (!phone) return null;
    const cleanInput = phone.replace(/\D/g, '').slice(-10);
    return db.users.find(u => {
      const matchPhone = (u.phone || '').replace(/\D/g, '').slice(-10) === cleanInput;
      if (!matchPhone) return false;
      if (role) {
        if (role === 'CUSTOMER') return u.role === 'CUSTOMER' || !u.role;
        return u.role === role;
      }
      return true;
    });
  }

  createUser(userData) {
    const db = this.readDb();
    if (!db.users) db.users = [];
    db.users.push(userData);
    this.writeDb(db);
    return userData;
  }

  getCustomers() {
    const db = this.readDb();
    return db.users.filter(u => u.role === 'CUSTOMER' || !u.role);
  }

  getDrivers() {
    const db = this.readDb();
    return db.driver_profiles || [];
  }

  getVehicles() {
    const db = this.readDb();
    const categories = (db.vehicle_categories || []).map(cat => {
      const def = this.defaultData.vehicle_categories.find(d => d.id === cat.id);
      const isCorrupted = typeof cat.icon === 'string' && (cat.icon.includes('ð') || !cat.icon.trim());
      return {
        ...cat,
        icon: isCorrupted && def ? def.icon : (cat.icon || (def ? def.icon : '🚚'))
      };
    });
    this.defaultData.vehicle_categories.forEach(defV => {
      if (!categories.some(c => c.id === defV.id)) categories.push(defV);
    });
    return categories;
  }

  getTrips() {
    const db = this.readDb();
    return db.trips || [];
  }

  getTripById(tripId) {
    const db = this.readDb();
    return (db.trips || []).find(t => t.id === tripId || t.tripId === tripId);
  }

  createTrip(tripData) {
    const db = this.readDb();
    if (!db.trips) db.trips = [];
    if (!tripData.internalValues && orderIdService) orderIdService.attachInternalValues(tripData);
    const formattedTrip = { ...tripData, version: tripData.version || 1, createdAt: tripData.createdAt || new Date().toISOString() };
    db.trips.push(formattedTrip);
    this.writeDb(db);
    return formattedTrip;
  }

  saveTrip(tripData) {
    const db = this.readDb();
    if (!db.trips) db.trips = [];
    const idx = db.trips.findIndex(t => t.id === tripData.id);
    if (idx >= 0) db.trips[idx] = tripData;
    else db.trips.push(tripData);
    this.writeDb(db);
    return tripData;
  }

  updateTripStatus(tripId, status) {
    const db = this.readDb();
    const trip = (db.trips || []).find(t => t.id === tripId);
    if (trip) {
      trip.status = status;
      trip.version = (trip.version || 1) + 1;
      if (status === 'COMPLETED' || status === 'DELIVERED') trip.completedAt = new Date().toISOString();
      this.writeDb(db);
    }
    return trip;
  }

  async transitionTripState(tripId, expectedVersion, nextState, actor, reason = '', idempotencyKey = null, metadata = {}) {
    const db = this.readDb();
    const trip = (db.trips || []).find(t => t.id === tripId);
    if (!trip) return { success: false, error: { code: 'TRIP_NOT_FOUND', message: 'Trip not found' } };

    const currentVersion = trip.version || 1;
    if (expectedVersion != null && currentVersion !== expectedVersion) {
      return { success: false, error: { code: 'CONCURRENCY_CONFLICT', message: `Optimistic concurrency conflict: expected version ${expectedVersion}, got ${currentVersion}` } };
    }

    if (!db.delivery_audit_logs) db.delivery_audit_logs = [];
    if (idempotencyKey) {
      const existing = db.delivery_audit_logs.find(l => l.order_id === tripId && l.idempotency_key === idempotencyKey);
      if (existing) return { success: true, trip, version: trip.version, cachedResult: true, auditLog: existing };
    }

    const fromState = trip.status;
    trip.status = nextState;
    trip.version = currentVersion + 1;
    trip.updatedAt = new Date().toISOString();
    const auditRecord = {
      id: db.delivery_audit_logs.length + 1,
      order_id: tripId,
      from_state: fromState,
      to_state: nextState,
      actor_type: actor ? actor.type : 'SYSTEM',
      actor_id: actor ? actor.id : 'SYSTEM',
      version: trip.version,
      idempotency_key: idempotencyKey,
      reason,
      metadata,
      timestamp: new Date().toISOString()
    };
    db.delivery_audit_logs.push(auditRecord);
    this.writeDb(db);
    return { success: true, trip, version: trip.version, auditLog: auditRecord };
  }

  async getAuditLogs(tripId) {
    const db = this.readDb();
    return (db.delivery_audit_logs || []).filter(l => l.order_id === tripId);
  }

  getAdminAnalytics() {
    const db = this.readDb();
    const trips = db.trips || [];
    const drivers = db.driver_profiles || [];
    const users = db.users || [];
    const totalGmv = trips.reduce((sum, t) => sum + (t.totalFare || 0), 0);
    const platformRevenue = Math.round(totalGmv * 0.18);
    const activeTripsCount = trips.filter(t => ['ACCEPTED', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED'].includes(t.status)).length;
    const completedTripsCount = trips.filter(t => ['COMPLETED', 'DELIVERED'].includes(t.status)).length;
    const onlineDriversCount = drivers.filter(d => d.status === 'ONLINE').length;
    const outstationTripsCount = trips.filter(t => t.isOutstation).length;
    return {
      totalGmv, platformRevenue, totalTrips: trips.length, activeTripsCount, completedTripsCount,
      onlineDriversCount, totalDrivers: drivers.length,
      totalCustomers: users.filter(u => u.role === 'CUSTOMER' || !u.role).length,
      outstationTripsCount,
      fleetUtilizationPercent: Math.round((onlineDriversCount / (drivers.length || 1)) * 100),
      recentTrips: trips.slice(-5).reverse(), drivers, systemSettings: db.system_settings
    };
  }
}

// 2. PostgreSQL Relational Database Repository Adapter
class PostgresDatabaseRepository extends DatabaseRepository {
  constructor(pool = null) {
    super();
    this.pool = pool || new PostgresPool();
  }

  async getUserByPhone(phone) {
    const res = await this.pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    return res.rows[0] || null;
  }

  async createUser(userData) {
    await this.pool.query('INSERT INTO users', [userData]);
    return userData;
  }

  async getCustomers() {
    const res = await this.pool.query('SELECT * FROM users');
    return res.rows.filter(u => u.role === 'CUSTOMER' || !u.role);
  }

  async getDrivers() {
    const res = await this.pool.query('SELECT * FROM driver_profiles');
    return res.rows;
  }

  async getVehicles() {
    const res = await this.pool.query('SELECT * FROM vehicles');
    return res.rows;
  }

  async getTrips() {
    const res = await this.pool.query('SELECT * FROM trips');
    return res.rows;
  }

  async getTripById(tripId) {
    const res = await this.pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
    return res.rows[0] || null;
  }

  async createTrip(tripData) {
    const formatted = { ...tripData, version: tripData.version || 1, createdAt: tripData.createdAt || new Date().toISOString() };
    await this.pool.query('INSERT INTO trips', [formatted]);
    return formatted;
  }

  async updateTripStatus(tripId, status) {
    const res = await this.pool.query('UPDATE trips SET status = $1 WHERE id = $2', [status, tripId]);
    if (res.rowCount > 0) return await this.getTripById(tripId);
    return null;
  }

  /**
   * Atomic PostgreSQL transition. All statements run through one leased
   * client, so BEGIN/COMMIT actually delimit one database transaction.
   */
  async transitionTripState(tripId, expectedVersion, nextState, actor, reason = '', idempotencyKey = null, metadata = {}) {
    return this.pool.withTransaction(async (client) => {
      const tripRes = await client.query(
        'SELECT * FROM trips WHERE id = $1 FOR UPDATE',
        [tripId]
      );
      const currentTrip = tripRes.rows[0];
      if (!currentTrip) return { success: false, error: { code: 'TRIP_NOT_FOUND', message: 'Trip not found' } };

      const currentVersion = Number(currentTrip.version || 1);
      if (expectedVersion != null && currentVersion !== Number(expectedVersion)) {
        metricsService.increment('postgres_concurrency_conflict_total');
        return {
          success: false,
          error: {
            code: 'CONCURRENCY_CONFLICT',
            message: `Optimistic concurrency conflict: expected version ${expectedVersion}, but current database version is ${currentVersion}`
          }
        };
      }

      if (idempotencyKey) {
        const existingRes = await client.query(
          'SELECT * FROM delivery_audit_logs WHERE order_id = $1 AND idempotency_key = $2 LIMIT 1',
          [tripId, idempotencyKey]
        );
        if (existingRes.rowCount > 0) {
          return {
            success: true,
            trip: currentTrip,
            version: currentVersion,
            cachedResult: true,
            auditLog: existingRes.rows[0]
          };
        }
      }

      const fromState = currentTrip.status;
      const updateRes = await client.query(
        'UPDATE trips SET status = $1, version = version + 1, updated_at = NOW() WHERE id = $2 AND version = $3 RETURNING *',
        [nextState, tripId, currentVersion]
      );
      if (updateRes.rowCount !== 1) {
        metricsService.increment('postgres_concurrency_conflict_total');
        return { success: false, error: { code: 'CONCURRENCY_CONFLICT', message: 'Trip version changed during transition' } };
      }

      const updatedTrip = updateRes.rows[0];
      const auditRes = await client.query(
        'INSERT INTO delivery_audit_logs (order_id, from_state, to_state, actor_type, actor_id, version, idempotency_key, reason, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
        [
          tripId,
          fromState,
          nextState,
          actor ? actor.type : 'SYSTEM',
          actor ? actor.id : 'SYSTEM',
          updatedTrip.version,
          idempotencyKey,
          reason,
          JSON.stringify(metadata)
        ]
      );

      return {
        success: true,
        trip: updatedTrip,
        version: updatedTrip.version,
        auditLog: auditRes.rows[0]
      };
    });
  }

  async getAuditLogs(tripId) {
    const res = await this.pool.query('SELECT * FROM delivery_audit_logs WHERE order_id = $1', [tripId]);
    return res.rows;
  }

  getAdminAnalytics() {
    return Promise.all([this.getTrips(), this.getDrivers(), this.getCustomers()]).then(([trips, drivers, users]) => {
      const totalGmv = trips.reduce((sum, t) => sum + (t.totalFare || 0), 0);
      const platformRevenue = Math.round(totalGmv * 0.18);
      const activeTripsCount = trips.filter(t => ['ACCEPTED', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED'].includes(t.status)).length;
      const completedTripsCount = trips.filter(t => ['COMPLETED', 'DELIVERED'].includes(t.status)).length;
      const onlineDriversCount = drivers.filter(d => d.status === 'ONLINE').length;
      return {
        totalGmv, platformRevenue, totalTrips: trips.length, activeTripsCount, completedTripsCount,
        onlineDriversCount, totalDrivers: drivers.length, totalCustomers: users.length,
        recentTrips: trips.slice(-5).reverse()
      };
    });
  }
}

module.exports = { DatabaseRepository, JsonDatabaseRepository, PostgresDatabaseRepository };
