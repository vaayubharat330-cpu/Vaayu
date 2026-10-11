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
    const categories = db.vehicle_categories || [];
    this.defaultData.vehicle_categories.forEach(defV => {
      if (!categories.some(c => c.id === defV.id)) {
        categories.push(defV);
      }
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
    if (!tripData.internalValues && orderIdService) {
      orderIdService.attachInternalValues(tripData);
    }
    const formattedTrip = {
      ...tripData,
      version: tripData.version || 1,
      createdAt: tripData.createdAt || new Date().toISOString()
    };
    db.trips.push(formattedTrip);
    this.writeDb(db);
    return formattedTrip;
  }

  saveTrip(tripData) {
    const db = this.readDb();
    if (!db.trips) db.trips = [];
    const idx = db.trips.findIndex(t => t.id === tripData.id);
    if (idx >= 0) {
      db.trips[idx] = tripData;
    } else {
      db.trips.push(tripData);
    }
    this.writeDb(db);
    return tripData;
  }

  updateTripStatus(tripId, status) {
    const db = this.readDb();
    const trip = (db.trips || []).find(t => t.id === tripId);
    if (trip) {
      trip.status = status;
      trip.version = (trip.version || 1) + 1;
      if (status === 'COMPLETED' || status === 'DELIVERED') {
        trip.completedAt = new Date().toISOString();
      }
      this.writeDb(db);
    }
    return trip;
  }

  async transitionTripState(tripId, expectedVersion, nextState, actor, reason = '', idempotencyKey = null, metadata = {}) {
    const db = this.readDb();
    const trip = (db.trips || []).find(t => t.id === tripId);

    if (!trip) {
      return { success: false, error: { code: 'TRIP_NOT_FOUND', message: 'Trip not found' } };
    }

    const currentVersion = trip.version || 1;
    if (expectedVersion != null && currentVersion !== expectedVersion) {
      return { success: false, error: { code: 'CONCURRENCY_CONFLICT', message: `Optimistic concurrency conflict: expected version ${expectedVersion}, got ${currentVersion}` } };
    }

    if (!db.delivery_audit_logs) db.delivery_audit_logs = [];

    // Idempotency Key Check
    if (idempotencyKey) {
      const existing = db.delivery_audit_logs.find(l => l.order_id === tripId && l.idempotency_key === idempotencyKey);
      if (existing) {
        return {
          success: true,
          trip,
          version: trip.version,
          cachedResult: true,
          auditLog: existing
        };
      }
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

    return {
      success: true,
      trip,
      version: trip.version,
      auditLog: auditRecord
    };
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
    const activeTripsCount = trips.filter(t => t.status === 'ACCEPTED' || t.status === 'SEARCHING_DRIVER' || t.status === 'DRIVER_ASSIGNED').length;
    const completedTripsCount = trips.filter(t => t.status === 'COMPLETED' || t.status === 'DELIVERED').length;
    const onlineDriversCount = drivers.filter(d => d.status === 'ONLINE').length;
    const outstationTripsCount = trips.filter(t => t.isOutstation).length;

    return {
      totalGmv,
      platformRevenue,
      totalTrips: trips.length,
      activeTripsCount,
      completedTripsCount,
      onlineDriversCount,
      totalDrivers: drivers.length,
      totalCustomers: users.filter(u => u.role === 'CUSTOMER' || !u.role).length,
      outstationTripsCount,
      fleetUtilizationPercent: Math.round((onlineDriversCount / (drivers.length || 1)) * 100),
      recentTrips: trips.slice(-5).reverse(),
      drivers,
      systemSettings: db.system_settings
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
    const formatted = {
      ...tripData,
      version: tripData.version || 1,
      createdAt: tripData.createdAt || new Date().toISOString()
    };
    await this.pool.query('INSERT INTO trips', [formatted]);
    return formatted;
  }

  async updateTripStatus(tripId, status) {
    const res = await this.pool.query('UPDATE trips SET status = $1 WHERE id = $2', [status, tripId]);
    if (res.rowCount > 0) {
      return await this.getTripById(tripId);
    }
    return null;
  }

  /**
   * Atomic PostgreSQL Transaction with Optimistic Concurrency Locking
   */
  async transitionTripState(tripId, expectedVersion, nextState, actor, reason = '', idempotencyKey = null, metadata = {}) {
    try {
      await this.pool.query('BEGIN');

      // 1. Optimistic Concurrency Lock Check
      const updateRes = await this.pool.query(
        'UPDATE trips SET status = $1, version = version + 1, updated_at = NOW() WHERE id = $2 AND version = $3 RETURNING version',
        [nextState, tripId, expectedVersion]
      );

      if (updateRes.rowCount === 0) {
        await this.pool.query('ROLLBACK');
        metricsService.increment('postgres_concurrency_conflict_total');
        metricsService.increment('postgres_transaction_failures_total');
        const existingTrip = await this.getTripById(tripId);
        if (!existingTrip) {
          return { success: false, error: { code: 'TRIP_NOT_FOUND', message: 'Trip not found' } };
        }
        return {
          success: false,
          error: {
            code: 'CONCURRENCY_CONFLICT',
            message: `Optimistic concurrency conflict: expected version ${expectedVersion}, but current database version is ${existingTrip.version}`
          }
        };
      }

      const newVersion = updateRes.rows[0].version;

      // 2. Append Audit Log Record
      const auditRes = await this.pool.query(
        'INSERT INTO delivery_audit_logs (order_id, from_state, to_state, actor_type, actor_id, version, idempotency_key, reason, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          tripId,
          'PREVIOUS',
          nextState,
          actor ? actor.type : 'SYSTEM',
          actor ? actor.id : 'SYSTEM',
          newVersion,
          idempotencyKey,
          reason,
          JSON.stringify(metadata)
        ]
      );

      await this.pool.query('COMMIT');

      const updatedTrip = await this.getTripById(tripId);
      return {
        success: true,
        trip: updatedTrip,
        version: newVersion,
        auditLog: auditRes.rows[0]
      };
    } catch (err) {
      await this.pool.query('ROLLBACK');
      
      // Handle Unique Constraint Violation for Idempotency Key
      if (err.code === '23505') {
        const existingTrip = await this.getTripById(tripId);
        const auditLogs = await this.getAuditLogs(tripId);
        const matchLog = auditLogs.find(l => l.idempotency_key === idempotencyKey);
        return {
          success: true,
          trip: existingTrip,
          version: existingTrip ? existingTrip.version : expectedVersion,
          cachedResult: true,
          auditLog: matchLog
        };
      }

      throw err;
    }
  }

  async getAuditLogs(tripId) {
    const res = await this.pool.query('SELECT * FROM delivery_audit_logs WHERE order_id = $1', [tripId]);
    return res.rows;
  }

  async getAdminAnalytics() {
    const trips = await this.getTrips();
    const drivers = await this.getDrivers();
    const users = await this.getCustomers();

    const totalGmv = trips.reduce((sum, t) => sum + (t.totalFare || 0), 0);
    const platformRevenue = Math.round(totalGmv * 0.18);
    const activeTripsCount = trips.filter(t => t.status === 'ACCEPTED' || t.status === 'SEARCHING_DRIVER' || t.status === 'DRIVER_ASSIGNED').length;
    const completedTripsCount = trips.filter(t => t.status === 'COMPLETED' || t.status === 'DELIVERED').length;
    const onlineDriversCount = drivers.filter(d => d.status === 'ONLINE').length;

    return {
      totalGmv,
      platformRevenue,
      totalTrips: trips.length,
      activeTripsCount,
      completedTripsCount,
      onlineDriversCount,
      totalDrivers: drivers.length,
      totalCustomers: users.length,
      recentTrips: trips.slice(-5).reverse()
    };
  }
}

module.exports = {
  DatabaseRepository,
  JsonDatabaseRepository,
  PostgresDatabaseRepository
};
