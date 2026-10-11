const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.resolve(process.env.VAAYU_DATA_FILE || path.join(__dirname, 'vaayu_store.json'));
const SQLITE_ENABLED = ['sqlite', 'sqlite3'].includes(String(process.env.PERSISTENCE_PROVIDER || '').toLowerCase());

const defaultData = {
  users: [],
  fleet_owners: [],
  merchants: [],
  merchant_schedules: [],
  driver_profiles: [],
  vehicle_categories: [
    {
      id: 'v_2w',
      name: 'VAAYU Express (2W)',
      code: 'V_2W',
      capacityKg: 20,
      dimensions: '40cm x 40cm x 40cm',
      baseFare: 40,
      includedKm: 2,
      perKmRate: 8,
      perMinRate: 1,
      helperCharge: 0,
      icon: '🛵',
      description: 'Documents, small parcels, food & electronics'
    },
    {
      id: 'v_mini_3w',
      name: 'VAAYU Mini 3W (Electric)',
      code: 'V_MINI_3W',
      capacityKg: 350,
      dimensions: '4.5ft x 3.5ft x 3.5ft',
      baseFare: 110,
      includedKm: 2,
      perKmRate: 14,
      perMinRate: 1.5,
      helperCharge: 80,
      icon: '🛺',
      description: 'Eco-friendly electric 3W for light commercial moves'
    },
    {
      id: 'v_3w',
      name: 'VAAYU Auto (3W)',
      code: 'V_3W',
      capacityKg: 500,
      dimensions: '5.5ft x 4ft x 4ft',
      baseFare: 150,
      includedKm: 2,
      perKmRate: 18,
      perMinRate: 2,
      helperCharge: 100,
      icon: '🚚',
      description: 'Piaggio Ape / Champion for commercial boxes & retail goods'
    },
    {
      id: 'v_ace',
      name: 'VAAYU Ace (Tata Ace 7ft)',
      code: 'V_TATA_ACE',
      capacityKg: 750,
      dimensions: '7ft x 4.8ft x 4.8ft',
      baseFare: 250,
      includedKm: 3,
      perKmRate: 22,
      perMinRate: 3,
      helperCharge: 150,
      icon: '🚚',
      description: 'Tata Ace 7ft for home shifting, furniture & heavy cargo'
    },
    {
      id: 'v_pickup_8ft',
      name: 'VAAYU Pickup (8ft)',
      code: 'V_PICKUP_8FT',
      capacityKg: 1200,
      dimensions: '8ft x 5ft x 5ft',
      baseFare: 350,
      includedKm: 3,
      perKmRate: 28,
      perMinRate: 4,
      helperCharge: 250,
      icon: '🚛',
      description: 'Mahindra Bolero Pickup for industrial equipment & tiles'
    },
    {
      id: 'v_pickup_9ft',
      name: 'VAAYU Pickup (9ft 1.5T)',
      code: 'V_PICKUP_9FT',
      capacityKg: 1500,
      dimensions: '9ft x 5.5ft x 5.5ft',
      baseFare: 450,
      includedKm: 4,
      perKmRate: 32,
      perMinRate: 5,
      helperCharge: 300,
      icon: '🚛',
      description: 'Bolero Maxi Truck 9ft for heavy commercial batches'
    },
    {
      id: 'v_14ft',
      name: 'VAAYU 14ft Truck (3.5T)',
      code: 'V_14FT',
      capacityKg: 3500,
      dimensions: '14ft x 6ft x 6ft',
      baseFare: 850,
      includedKm: 5,
      perKmRate: 45,
      perMinRate: 7,
      helperCharge: 500,
      icon: '🚛',
      description: 'Eicher / Tata 407 14ft container for full house & industrial moves'
    },
    {
      id: 'v_17ft',
      name: 'VAAYU 17ft Heavy Truck (5T)',
      code: 'V_17FT',
      capacityKg: 5000,
      dimensions: '17ft x 7ft x 7ft',
      baseFare: 1200,
      includedKm: 5,
      perKmRate: 55,
      perMinRate: 9,
      helperCharge: 700,
      icon: '🚛',
      description: 'Eicher 17ft Heavy Truck for full 3-4 BHK house shifting & bulk industrial freight'
    }
  ],
  trips: [],
  system_settings: {
    maintenanceMode: false,
    otaVersion: 'v2.4.1 Production',
    releaseNotes: 'Hyderabad Metro Expansion, 17ft Heavy Commercial Fleet & Dynamic Waiting Time Billing',
    surgeMultiplier: 1.0,
    featureFlags: {
      enableOutstation: true,
      enable17ftTruck: true,
      enableHouseShifting: true,
      enableWalletTopup: true,
      enableWaitingTimeBilling: true
    }
  },
  support_tickets: [],
  automation_logs: [],
  advertisements: [],
  zones: [
    {
      id: 'ZONE_101',
      name: 'Cyberabad & Hitec City Tech Zone',
      city: 'Hyderabad',
      surgeMultiplier: 1.0,
      status: 'ACTIVE',
      activeDrivers: 6,
      maxFleetCapacity: 50,
      description: 'Covers Mindspace, DLF Cybercity, Financial District & Kondapur'
    },
    {
      id: 'ZONE_102',
      name: 'Kukatpally & KPHB Commercial Zone',
      city: 'Hyderabad',
      surgeMultiplier: 1.1,
      status: 'ACTIVE',
      activeDrivers: 4,
      maxFleetCapacity: 40,
      description: 'High retail & residential transport volume near JNTU & Forum Mall'
    },
    {
      id: 'ZONE_103',
      name: 'Sanathnagar & Jeedimetla Industrial Belt',
      city: 'Hyderabad',
      surgeMultiplier: 1.15,
      status: 'ACTIVE',
      activeDrivers: 3,
      maxFleetCapacity: 35,
      description: 'Heavy truck priority zone for manufacturing & factory cargo'
    },
    {
      id: 'ZONE_104',
      name: 'Shamshabad RGIA Airport Cargo Corridor',
      city: 'Hyderabad',
      surgeMultiplier: 1.25,
      status: 'ACTIVE',
      activeDrivers: 2,
      maxFleetCapacity: 25,
      description: '24/7 express air cargo freight transport to and from RGIA Airport'
    },
    {
      id: 'ZONE_105',
      name: 'Secunderabad & Begumpet Logistics Hub',
      city: 'Hyderabad',
      surgeMultiplier: 1.0,
      status: 'ACTIVE',
      activeDrivers: 3,
      maxFleetCapacity: 30,
      description: 'Railway station logistics & wholesale commercial markets'
    }
  ],
  disputes: [],
  broadcasts: [],
  driver_documents: [],
  order_rejections: [],
  payouts: [],
  daily_logs: [],
  telemetry_logs: [],
  kyc_summaries: {},
  otpRequests: []
};

// Initialize DB file
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
}

// In-Memory Fast Cache for Sub-Millisecond DB Access
let cachedDbMemory = null;
let sqliteDatabase = null;

if (SQLITE_ENABLED) {
  const { DatabaseSync } = require('node:sqlite');
  const sqlitePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'vaayu_dev.sqlite'));
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  sqliteDatabase = new DatabaseSync(sqlitePath);
  sqliteDatabase.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  sqliteDatabase.exec(`CREATE TABLE IF NOT EXISTS vaayu_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const existingState = sqliteDatabase.prepare('SELECT id FROM vaayu_state WHERE id = 1').get();
  if (!existingState) {
    // A newly created SQLite demo database must be deterministic and clean.
    // The JSON store is mutable legacy state and can contain prior trips/edits.
    const seed = SQLITE_ENABLED
      ? JSON.parse(JSON.stringify(defaultData))
      : JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    sqliteDatabase.prepare('INSERT INTO vaayu_state (id, payload) VALUES (1, ?)').run(JSON.stringify(seed));
  }
}

const PG_STORE_ENABLED = ['postgres', 'postgresql'].includes(String(process.env.PERSISTENCE_PROVIDER || '').toLowerCase());
let pgStore = null;

// Loads the PostgreSQL store before the server accepts traffic. Call once at startup.
async function initPersistence() {
  if (!PG_STORE_ENABLED) return;
  const { PgBackedStore } = require('./pgBackedStore');
  if (!process.env.DATABASE_URL) throw new Error('PERSISTENCE_PROVIDER=postgres requires DATABASE_URL.');
  pgStore = new PgBackedStore(process.env.DATABASE_URL);
  cachedDbMemory = await pgStore.load();
}

async function shutdownPersistence() {
  if (pgStore) await pgStore.drain();
}

// Resolves once every write made so far is committed. Resolves immediately on the JSON store.
async function waitForCommit() {
  if (pgStore) await pgStore.flushAll();
}

function hasPendingWrites() {
  return pgStore ? pgStore.hasPending() : false;
}

function readDb() {
  if (cachedDbMemory) return cachedDbMemory;

  try {
    const raw = sqliteDatabase
      ? sqliteDatabase.prepare('SELECT payload FROM vaayu_state WHERE id = 1').get()?.payload
      : fs.readFileSync(DB_FILE, 'utf8');
    if (!raw) throw new Error('VAAYU database state row is missing');
    const parsed = JSON.parse(raw);
    if (!parsed.system_settings) parsed.system_settings = defaultData.system_settings;
    if (!parsed.support_tickets) parsed.support_tickets = defaultData.support_tickets;
    if (!parsed.automation_logs) parsed.automation_logs = defaultData.automation_logs;
    if (!parsed.advertisements) parsed.advertisements = defaultData.advertisements;
    if (!parsed.zones) parsed.zones = defaultData.zones;
    if (!parsed.disputes) parsed.disputes = defaultData.disputes;
    if (!parsed.broadcasts) parsed.broadcasts = defaultData.broadcasts;
    if (!parsed.driver_documents) parsed.driver_documents = defaultData.driver_documents;
    if (!parsed.order_rejections) parsed.order_rejections = defaultData.order_rejections;
    if (!parsed.payouts) parsed.payouts = defaultData.payouts;
    if (!parsed.daily_logs) parsed.daily_logs = defaultData.daily_logs;
    if (!parsed.telemetry_logs) parsed.telemetry_logs = defaultData.telemetry_logs;
    if (!parsed.kyc_summaries) parsed.kyc_summaries = defaultData.kyc_summaries;
    if (!parsed.otpRequests) parsed.otpRequests = [];
    if (!parsed.fleet_owners) parsed.fleet_owners = defaultData.fleet_owners;
    if (!parsed.wallet_ledger) parsed.wallet_ledger = [];

    cachedDbMemory = parsed;
    return cachedDbMemory;
  } catch (e) {
    throw new Error(`Unable to load VAAYU ${sqliteDatabase ? 'SQLite' : 'JSON'} database: ${e.message}`);
  }
}

function writeDb(data) {
  if (pgStore) {
    pgStore.write(data);
    cachedDbMemory = data;
    return;
  }
  if (sqliteDatabase) {
    const update = sqliteDatabase.prepare('UPDATE vaayu_state SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1');
    const result = update.run(JSON.stringify(data));
    if (Number(result.changes) !== 1) throw new Error('Unable to persist VAAYU SQLite database: state row is missing');
    cachedDbMemory = data;
    return;
  }
  const tempFile = `${DB_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, DB_FILE);
    cachedDbMemory = data;
  } catch (error) {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    throw new Error(`Unable to persist VAAYU JSON database: ${error.message}`);
  }
}

const { JsonDatabaseRepository, PostgresDatabaseRepository } = require('./repository');
const jsonRepo = new JsonDatabaseRepository(readDb, writeDb, defaultData);
const postgresRepo = new PostgresDatabaseRepository();

function getActiveRepository() {
  // Both the JSON file and PostgreSQL go through readDb/writeDb, so the same synchronous repository serves them.
  return jsonRepo;
}

module.exports = {
  getDb: readDb,
  saveDb: writeDb,
  initPersistence,
  shutdownPersistence,
  waitForCommit,
  hasPendingWrites,
  getActiveRepository,
  jsonRepo,
  postgresRepo,

  getUserByPhone: (phone) => getActiveRepository().getUserByPhone(phone),
  createUser: (userData) => getActiveRepository().createUser(userData),
  getCustomers: () => getActiveRepository().getCustomers(),
  getDrivers: () => getActiveRepository().getDrivers(),
  getVehicles: () => getActiveRepository().getVehicles(),
  getTrips: () => getActiveRepository().getTrips(),
  getTripById: (tripId) => getActiveRepository().getTripById(tripId),
  createTrip: (tripData) => getActiveRepository().createTrip(tripData),
  saveTrip: (tripData) => getActiveRepository().saveTrip(tripData),
  updateTripStatus: (tripId, status) => getActiveRepository().updateTripStatus(tripId, status),
  transitionTripState: (tripId, expectedVersion, nextState, actor, reason, idempotencyKey, metadata) => 
    getActiveRepository().transitionTripState(tripId, expectedVersion, nextState, actor, reason, idempotencyKey, metadata),
  getAuditLogs: (tripId) => getActiveRepository().getAuditLogs(tripId),

  getFleetOwnerData: () => {
    const db = readDb();
    const owner = db.fleet_owners[0];
    const drivers = db.driver_profiles.filter(d => d.fleetOwnerId === owner.id);
    const totalEarnings = drivers.reduce((sum, d) => sum + d.todayEarnings, 0);
    const totalTrips = drivers.reduce((sum, d) => sum + d.totalTrips, 0);

    return {
      owner,
      drivers,
      totalEarnings,
      totalTrips
    };
  },

  getAvailableDriver: (vehicleId) => {
    const db = readDb();
    return (db.driver_profiles || []).find(d => d.vehicleId === vehicleId && d.status === 'ONLINE') || null;
  },

  // ADMIN OPERATIONS METHODS
  getAdminAnalytics: () => {
    const db = readDb();
    const trips = db.trips || [];
    const drivers = db.driver_profiles || [];
    const users = db.users || [];

    const totalGmv = trips.reduce((sum, t) => sum + (t.totalFare || 0), 0);
    const platformRevenue = Math.round(totalGmv * 0.18);
    const activeTripStatuses = new Set(['ACCEPTED', 'DISPATCHING', 'DRIVER_ASSIGNED', 'IN_TRANSIT']);
    const completedTripStatuses = new Set(['COMPLETED', 'DELIVERED']);
    const activeTripsCount = trips.filter(t => activeTripStatuses.has(String(t.status || '').toUpperCase())).length;
    const completedTripsCount = trips.filter(t => completedTripStatuses.has(String(t.status || '').toUpperCase())).length;
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
      drivers: drivers,
      systemSettings: db.system_settings
    };
  },

  createDriverApplication: (application) => {
    const db = readDb();
    if (!db.driver_applications) db.driver_applications = [];
    const now = new Date().toISOString();
    const record = {
      id: `drv_app_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      name: application.name,
      phone: application.phone,
      vehicleId: application.vehicleId,
      vehicleNumber: application.vehicleNumber,
      licenseNumber: application.licenseNumber,
      city: application.city || 'Hyderabad',
      email: application.email || null,
      status: 'PENDING',
      createdAt: now,
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    };
    db.driver_applications.push(record);
    writeDb(db);
    return record;
  },

  decideDriverApplication: (applicationId, decision) => {
    const db = readDb();
    const target = (db.driver_applications || []).find(a => a.id === applicationId);
    if (!target) return null;
    Object.assign(target, {
      status: decision.status,
      reviewedAt: new Date().toISOString(),
      reviewedBy: decision.reviewedBy,
      reviewNote: decision.reviewNote,
      driverId: decision.driverId,
    });
    writeDb(db);
    return target;
  },

  createDriverProfile: (profile) => {
    const db = readDb();
    if (!db.driver_profiles) db.driver_profiles = [];
    if (!db.users) db.users = [];
    const phone = String(profile.phone || '').replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) return { success: false, error: 'A valid 10-digit driver phone number is required.' };
    if (db.driver_profiles.some(d => String(d.phone || '').replace(/\D/g, '').slice(-10) === phone)) {
      return { success: false, error: 'A driver with this phone number already exists.' };
    }
    const now = new Date().toISOString();
    const userId = `usr_drv_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const driverId = `drv_prof_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    db.users.push({
      id: userId,
      phone: `+91 ${phone}`,
      name: profile.name,
      email: profile.email || `${phone}@vaayu.in`,
      city: profile.city || 'Hyderabad',
      role: 'DRIVER',
      createdAt: now
    });
    const driver = {
      id: driverId,
      userId,
      name: profile.name,
      phone: `+91 ${phone}`,
      vehicleId: profile.vehicleId,
      vehicleNumber: profile.vehicleNumber || null,
      licenseNumber: profile.licenseNumber || null,
      fleetOwnerId: profile.fleetOwnerId || null,
      status: 'OFFLINE',
      kycStatus: 'PENDING',
      rating: null,
      totalTrips: 0,
      createdAt: now,
      auditTrail: []
    };
    db.driver_profiles.push(driver);
    writeDb(db);
    return { success: true, driver, userId };
  },

  updateDriverKyc: (driverId, kycStatus) => {
    const db = readDb();
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    if (driver) {
      driver.kycStatus = kycStatus;
      writeDb(db);
    }
    return driver;
  },

  updateDriverStatus: (driverId, status) => {
    const db = readDb();
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    if (driver) {
      driver.status = status;
      writeDb(db);
    }
    return driver;
  },

  updateDriverProfile: (driverId, changes = {}) => {
    const db = readDb();
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    if (!driver) return null;
    for (const key of ['status', 'vehicleId', 'currentLat', 'currentLng']) {
      if (changes[key] !== undefined) driver[key] = changes[key];
    }
    driver.updatedAt = new Date().toISOString();
    writeDb(db);
    return driver;
  },

  recordDriverTripCompletion: (driverId, tripId, earnings) => {
    const db = readDb();
    if (!db.driver_earning_entries) db.driver_earning_entries = [];
    const existing = db.driver_earning_entries.find(entry => entry.tripId === tripId);
    if (existing) return { success: true, duplicate: true, entry: existing };
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    if (!driver) return { success: false, error: 'Driver profile not found.' };
    const amount = Number(earnings);
    if (!Number.isFinite(amount) || amount < 0) return { success: false, error: 'Invalid trip earnings.' };
    const completedAt = new Date().toISOString();
    const entry = { id: `EARN_${crypto.randomUUID()}`, tripId, driverId: driver.id, amount, completedAt };
    db.driver_earning_entries.push(entry);
    driver.totalTrips = Number(driver.totalTrips || 0) + 1;
    driver.todayTrips = Number(driver.todayTrips || 0) + 1;
    driver.todayEarnings = Number(driver.todayEarnings || 0) + amount;
    driver.pocketBalance = Number(driver.pocketBalance || 0) + amount;
    const dateKey = completedAt.slice(0, 10);
    if (!db.daily_logs) db.daily_logs = [];
    let daily = db.daily_logs.find(log => log.driverId === driver.id && (log.logDate || log.log_date) === dateKey);
    if (!daily) {
      daily = { id: `LOG_${driver.id}_${dateKey}`, driverId: driver.id, logDate: dateKey, dayLabel: dateKey, isToday: true, orders: 0, hours: 0, earnings: 0, breakdown: { basePay: 0, surge: 0, incentive: 0, codCollected: 0 } };
      db.daily_logs.push(daily);
    }
    daily.orders = Number(daily.orders || 0) + 1;
    daily.earnings = Number(daily.earnings || 0) + amount;
    daily.basePay = Number(daily.basePay || 0) + amount;
    if (!daily.breakdown) daily.breakdown = { basePay: 0, surge: 0, incentive: 0, codCollected: 0 };
    daily.breakdown.basePay = Number(daily.breakdown.basePay || 0) + amount;
    writeDb(db);
    return { success: true, entry, driver };
  },

  updateVehiclePricing: (vehicleId, pricingData) => {
    const db = readDb();
    const vehicle = (db.vehicle_categories || []).find(v => v.id === vehicleId);
    if (vehicle) {
      if (pricingData.baseFare !== undefined) vehicle.baseFare = parseInt(pricingData.baseFare, 10);
      if (pricingData.includedKm !== undefined) vehicle.includedKm = parseInt(pricingData.includedKm, 10);
      if (pricingData.perKmRate !== undefined) vehicle.perKmRate = parseInt(pricingData.perKmRate, 10);
      if (pricingData.perMinRate !== undefined) vehicle.perMinRate = parseFloat(pricingData.perMinRate);
      if (pricingData.helperCharge !== undefined) vehicle.helperCharge = parseInt(pricingData.helperCharge, 10);
      writeDb(db);
    }
    return vehicle;
  },

  getSystemSettings: () => {
    const db = readDb();
    return db.system_settings || defaultData.system_settings;
  },

  updateSystemSettings: (settingsData) => {
    const db = readDb();
    const currentSettings = db.system_settings || defaultData.system_settings;
    db.system_settings = {
      ...currentSettings,
      ...settingsData,
      featureFlags: {
        ...(currentSettings.featureFlags || {}),
        ...(settingsData.featureFlags || {})
      }
    };
    writeDb(db);
    return db.system_settings;
  },

  creditCustomerWallet: (customerId, amount, reason, creditedBy) => {
    const db = readDb();
    const customer = (db.users || []).find(user => user.id === customerId && (user.role === 'CUSTOMER' || !user.role));
    if (!customer) return null;
    const credit = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(credit) || credit <= 0 || credit > 5000) throw new Error('Credit amount must be between ₹0.01 and ₹5,000.');
    const entry = {
      id: `WALLET_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      customerId,
      type: 'ADMIN_CREDIT',
      amount: credit,
      reason: String(reason || '').trim(),
      creditedBy,
      createdAt: new Date().toISOString()
    };
    customer.walletBalance = Math.round(((Number(customer.walletBalance) || 0) + credit) * 100) / 100;
    if (!db.wallet_ledger) db.wallet_ledger = [];
    db.wallet_ledger.push(entry);
    writeDb(db);
    return { customer, entry };
  },

  topUpCustomerWallet: (customerId, amount, referenceId) => {
    const db = readDb();
    const customer = (db.users || []).find(user => user.id === customerId && (user.role === 'CUSTOMER' || !user.role));
    if (!customer) return null;
    const credit = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(credit) || credit <= 0 || credit > 10000) throw new Error('Top-up amount must be between ₹0.01 and ₹10,000.');
    if (!db.wallet_ledger) db.wallet_ledger = [];
    const existing = referenceId && db.wallet_ledger.find(entry => entry.referenceId === referenceId);
    if (existing) return { customer, entry: existing };
    const entry = { id: `WALLET_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, customerId, type: 'DEMO_TOP_UP', amount: credit, referenceId: referenceId || null, createdAt: new Date().toISOString() };
    customer.walletBalance = Math.round(((Number(customer.walletBalance) || 0) + credit) * 100) / 100;
    db.wallet_ledger.push(entry);
    writeDb(db);
    return { customer, entry };
  },

  debitCustomerWallet: (customerId, amount, tripId) => {
    const db = readDb();
    const customer = (db.users || []).find(user => user.id === customerId && (user.role === 'CUSTOMER' || !user.role));
    if (!customer) return { success: false, error: 'Customer wallet could not be found.' };
    const debit = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(debit) || debit <= 0) return { success: false, error: 'Wallet debit amount is invalid.' };
    if (!db.wallet_ledger) db.wallet_ledger = [];
    const existing = db.wallet_ledger.find(entry => entry.referenceId === tripId && entry.type === 'TRIP_PAYMENT');
    if (existing) return { success: true, customer, entry: existing };
    const balance = Number(customer.walletBalance) || 0;
    if (balance < debit) return { success: false, error: `Insufficient wallet balance. Available ₹${balance.toFixed(2)}, required ₹${debit.toFixed(2)}.` };
    const entry = { id: `WALLET_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, customerId, type: 'TRIP_PAYMENT', amount: -debit, referenceId: tripId, createdAt: new Date().toISOString() };
    customer.walletBalance = Math.round((balance - debit) * 100) / 100;
    db.wallet_ledger.push(entry);
    writeDb(db);
    return { success: true, customer, entry };
  },

  getSupportTickets: () => {
    const db = readDb();
    return db.support_tickets || [];
  },

  updateSupportTicket: (ticketId, updateData) => {
    const db = readDb();
    const ticket = (db.support_tickets || []).find(t => t.id === ticketId);
    if (ticket) {
      if (updateData.status) ticket.status = updateData.status;
      if (updateData.assignedAgent) ticket.assignedAgent = updateData.assignedAgent;
      if (updateData.reply) {
        if (!ticket.replies) ticket.replies = [];
        ticket.replies.push({ reply: updateData.reply, timestamp: new Date().toISOString() });
      }
      writeDb(db);
    }
    return ticket;
  },

  getAutomationLogs: () => {
    const db = readDb();
    return db.automation_logs || [];
  },

  getTripMessages: (tripId) => {
    const db = readDb();
    if (!db.chat_messages) db.chat_messages = [];
    return db.chat_messages.filter(m => m.tripId === tripId);
  },

  addTripMessage: (tripId, senderRole, senderName, messageText) => {
    const db = readDb();
    if (!db.chat_messages) db.chat_messages = [];
    const newMessage = {
      id: `msg_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      tripId,
      senderRole, // 'CUSTOMER' or 'DRIVER'
      senderName,
      messageText,
      timestamp: new Date().toISOString()
    };
    db.chat_messages.push(newMessage);
    writeDb(db);
    return newMessage;
  },

  // ADVERTISEMENT MANAGEMENT METHODS
  getAdvertisements: () => {
    const db = readDb();
    return db.advertisements || [];
  },

  getActiveAdvertisements: () => {
    const db = readDb();
    const ads = db.advertisements || [];
    // Increment impressions count when fetched for display
    ads.forEach(ad => {
      if (ad.status === 'ACTIVE') ad.impressions = (ad.impressions || 0) + 1;
    });
    writeDb(db);
    return ads.filter(a => a.status === 'ACTIVE');
  },

  createAdvertisement: (adData) => {
    const db = readDb();
    if (!db.advertisements) db.advertisements = [];
    const newAd = {
      id: `AD_${Date.now()}`,
      businessName: adData.businessName || 'Partner Business',
      category: adData.category || 'Retail & Logistics',
      title: adData.title || 'Promotional Offer',
      subtitle: adData.subtitle || '',
      imageUrl: adData.imageUrl || 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=800&auto=format&fit=crop&q=80',
      actionUrl: adData.actionUrl || '#',
      ctaText: adData.ctaText || 'Call Business Now',
      placement: adData.placement || 'HOME_BANNER',
      status: 'ACTIVE',
      impressions: 0,
      clicks: 0,
      createdAt: new Date().toISOString()
    };
    db.advertisements.push(newAd);
    writeDb(db);
    return newAd;
  },

  updateAdvertisementStatus: (adId, status) => {
    const db = readDb();
    const ad = (db.advertisements || []).find(a => a.id === adId);
    if (ad) {
      ad.status = status;
      writeDb(db);
    }
    return ad;
  },

  deleteAdvertisement: (adId) => {
    const db = readDb();
    const ads = db.advertisements || [];
    const existingCount = ads.length;
    db.advertisements = ads.filter(a => a.id !== adId);
    if (db.advertisements.length === existingCount) return false;
    writeDb(db);
    return true;
  },

  incrementAdClick: (adId) => {
    const db = readDb();
    const ad = (db.advertisements || []).find(a => a.id === adId);
    if (ad) {
      ad.clicks = (ad.clicks || 0) + 1;
      writeDb(db);
    }
    return ad;
  },

  // ZONE MANAGEMENT METHODS
  getZones: () => {
    const db = readDb();
    return db.zones || [];
  },

  updateZoneSurge: (zoneId, surgeMultiplier) => {
    const db = readDb();
    const zone = (db.zones || []).find(z => z.id === zoneId);
    if (zone) {
      zone.surgeMultiplier = parseFloat(surgeMultiplier);
      writeDb(db);
    }
    return zone;
  },

  toggleZoneStatus: (zoneId, status) => {
    const db = readDb();
    const zone = (db.zones || []).find(z => z.id === zoneId);
    if (zone) {
      zone.status = status;
      writeDb(db);
    }
    return zone;
  },

  createZone: (zoneData) => {
    const db = readDb();
    if (!db.zones) db.zones = [];
    const newZone = {
      id: `ZONE_${Date.now()}`,
      name: zoneData.name || 'New Logistics Corridor',
      city: zoneData.city || 'Hyderabad',
      surgeMultiplier: parseFloat(zoneData.surgeMultiplier) || 1.0,
      status: 'ACTIVE',
      activeDrivers: 0,
      maxFleetCapacity: parseInt(zoneData.maxFleetCapacity, 10) || 30,
      description: zoneData.description || '',
      tollFee: String(zoneData.tollFee ?? '').trim() !== '' && Number.isFinite(Number(zoneData.tollFee)) && Number(zoneData.tollFee) >= 0 ? Math.round(Number(zoneData.tollFee)) : 0,
      centerLat: String(zoneData.centerLat ?? '').trim() !== '' && Number.isFinite(Number(zoneData.centerLat)) ? Number(zoneData.centerLat) : null,
      centerLng: String(zoneData.centerLng ?? '').trim() !== '' && Number.isFinite(Number(zoneData.centerLng)) ? Number(zoneData.centerLng) : null,
      radiusKm: String(zoneData.radiusKm ?? '').trim() !== '' && Number.isFinite(Number(zoneData.radiusKm)) && Number(zoneData.radiusKm) > 0 ? Number(zoneData.radiusKm) : null
    };
    db.zones.push(newZone);
    writeDb(db);
    return newZone;
  },

  // DISPUTE RESOLUTION & REFUND METHODS
  getDisputes: () => {
    const db = readDb();
    return db.disputes || [];
  },

  resolveDispute: (disputeId, action, amount, resolvedBy, notes) => {
    const db = readDb();
    const dispute = (db.disputes || []).find(d => d.id === disputeId);
    if (dispute && dispute.status === 'PENDING') {
      dispute.status = action === 'APPROVE' ? 'REFUND_APPROVED_PENDING_PROCESSING' : 'REJECTED';
      dispute.refundAmountApproved = action === 'APPROVE' ? parseInt(amount || dispute.requestedRefund, 10) : 0;
      dispute.resolvedBy = resolvedBy || 'Admin Agent';
      dispute.resolutionNotes = notes || (action === 'APPROVE' ? 'Refund approved and pending payment processor integration.' : 'Dispute claim reviewed and rejected.');
      writeDb(db);
    }
    return dispute;
  },

  // BROADCAST CAMPAIGN METHODS
  getBroadcasts: () => {
    const db = readDb();
    return db.broadcasts || [];
  },

  sendBroadcast: (bcastData) => {
    const db = readDb();
    if (!db.broadcasts) db.broadcasts = [];
    const newBcast = {
      id: `BCAST_${Date.now()}`,
      title: bcastData.title || 'Promotional Notification',
      channel: bcastData.channel || 'WHATSAPP',
      targetAudience: bcastData.targetAudience || 'ALL_CUSTOMERS',
      messageText: bcastData.messageText || '',
      promoCode: bcastData.promoCode || 'NONE',
      status: 'QUEUED',
      sentCount: 0,
      queuedAt: new Date().toISOString()
    };
    db.broadcasts.push(newBcast);

    // Record in automation logs
    if (!db.automation_logs) db.automation_logs = [];
    db.automation_logs.push({
      id: `AUT_${Date.now()}`,
      event: 'MARKETING_BROADCAST_QUEUED',
      channel: newBcast.channel,
      recipient: `Target: ${newBcast.targetAudience} (delivery pending provider integration)`,
      status: 'QUEUED',
      payload: newBcast.messageText,
      timestamp: new Date().toISOString()
    });

    writeDb(db);
    return newBcast;
  },

  updateBroadcastDelivery: (broadcastId, status, error = null) => {
    const db = readDb();
    const item = (db.broadcasts || []).find(entry => entry.id === broadcastId);
    if (!item) return null;
    item.status = status;
    item.providerError = error ? String(error).slice(0, 300) : null;
    item.providerUpdatedAt = new Date().toISOString();
    writeDb(db);
    return item;
  },

  // DRIVER PARTNER & KYC METHODS
  getFleetOwners: () => {
    const db = readDb();
    return db.fleet_owners || defaultData.fleet_owners;
  },

  getDriverDocuments: (driverId) => {
    const db = readDb();
    const docs = db.driver_documents || [];
    if (!driverId) return docs;
    return docs.filter(d => d.driverId === driverId);
  },

  updateDriverDocument: (docId, updateData) => {
    const db = readDb();
    const docs = db.driver_documents || [];
    const doc = docs.find(d => d.id === docId);
    if (doc) {
      if (updateData.status) doc.status = updateData.status;
      if (updateData.notes) doc.notes = updateData.notes;
      if (updateData.verifiedBy) doc.verifiedBy = updateData.verifiedBy;
      doc.verifiedAt = new Date().toISOString();
      writeDb(db);
    }
    return doc;
  },

  saveDriverDocument: (docData) => {
    const db = readDb();
    if (!db.driver_documents) db.driver_documents = [];
    const newDoc = {
      id: `DOC_${Date.now()}`,
      driverId: docData.driver_id || docData.driverId || null,
      docType: docData.doc_type || docData.docType,
      docTitle: docData.doc_title || docData.docTitle || 'Verification Document',
      filePath: docData.file_path || docData.filePath,
      docNumber: docData.doc_number || docData.docNumber || null,
      status: 'PENDING_REVIEW',
      confidenceScore: null,
      ocrResult: docData.ocr_data || docData.ocrData || {},
      uploadedAt: new Date().toISOString()
    };
    db.driver_documents.push(newDoc);
    writeDb(db);
    return newDoc;
  },

  getKycSummary: (driverId) => {
    const db = readDb();
    const summaryMap = db.kyc_summaries || {};
    return summaryMap[driverId] || {
      driverId: driverId || null,
      step: 1,
      status: 'PENDING',
      all_owner_docs_verified: false,
      owner_name: null
    };
  },

  updateKycStep: (driverId, step, status, ownerName) => {
    const db = readDb();
    if (!db.kyc_summaries) db.kyc_summaries = {};
    const targetId = driverId;
    if (!targetId) return null;
    db.kyc_summaries[targetId] = {
      driverId: targetId,
      step: step || 1,
      status: status || 'PENDING',
      all_owner_docs_verified: status === 'APPROVED',
      owner_name: ownerName || null
    };
    writeDb(db);
    return db.kyc_summaries[targetId];
  },

  autoVerifyDocumentsWithAi: (driverId, category = 'all', ownerName = null) => {
    const db = readDb();
    const targetId = driverId;
    if (!targetId) return { success: false, error: 'Driver not found.' };
    if (!db.kyc_summaries) db.kyc_summaries = {};
    db.kyc_summaries[targetId] = {
      driverId: targetId,
      step: 2,
      status: 'PENDING_REVIEW',
      all_owner_docs_verified: false,
      owner_name: ownerName
    };
    writeDb(db);
    return { success: true, status: 'PENDING_REVIEW', message: 'Documents received and queued for human verification.' };
  },

  saveVehicleDetails: (driverId, vehicleNumber, city, vehicleType, bodyType, fuelType) => {
    const db = readDb();
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    if (driver) {
      if (vehicleNumber) driver.vehicleNumber = vehicleNumber;
      if (vehicleType) driver.vehicleId = vehicleType;
      writeDb(db);
    }
    return { success: true, message: 'Vehicle details saved and verified.' };
  },

  saveDriverDetails: (driverId, isSelfDriving, driverName, driverPhone) => {
    const db = readDb();
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    if (driver) {
      if (driverName) driver.name = driverName;
      if (driverPhone) driver.phone = driverPhone;
      writeDb(db);
      return { success: true, message: 'Driver details saved.' };
    }
    return { success: false, error: { code: 'DRIVER_NOT_FOUND', message: 'No driver profile exists for this account.' } };
  },

  // ORDER REJECTION & WEBRTC VIDEO PROOF METHODS
  getOrderRejections: (driverId = null) => {
    const db = readDb();
    const list = db.order_rejections || [];
    if (driverId) {
      return list.filter(r => r.driverId === driverId);
    }
    return list;
  },

  createOrderRejection: (rejectionData) => {
    const db = readDb();
    if (!db.order_rejections) db.order_rejections = [];
    const newRejection = {
      id: `REJ_${Date.now()}`,
      orderId: rejectionData.orderId || rejectionData.order_id || null,
      driverId: rejectionData.driverId || rejectionData.driver_id || null,
      driverName: rejectionData.driverName || null,
      driverPhone: rejectionData.driverPhone || null,
      vehicleName: rejectionData.vehicleName || null,
      reason: rejectionData.reason || 'vehicle_breakdown',
      reasonTitle: rejectionData.reasonTitle || 'Emergency Order Cancellation',
      notes: rejectionData.notes || '',
      videoUrl: rejectionData.videoUrl || rejectionData.video_url || null,
      durationSeconds: rejectionData.durationSeconds == null || rejectionData.durationSeconds === '' ? null : (Number.isFinite(Number(rejectionData.durationSeconds)) ? Number(rejectionData.durationSeconds) : null),
      status: 'PENDING_REVIEW',
      createdAt: new Date().toISOString()
    };
    db.order_rejections.push(newRejection);
    writeDb(db);
    return newRejection;
  },

  updateOrderRejection: (rejectionId, action, notes) => {
    const db = readDb();
    const rej = (db.order_rejections || []).find(r => r.id === rejectionId);
    if (rej && rej.status === 'PENDING_REVIEW') {
      rej.status = action === 'APPROVE' ? 'APPROVED_NO_PENALTY' : 'REJECTED_PENALTY_PENDING_RECONCILIATION';
      rej.reviewNotes = notes || (action === 'APPROVE' ? 'Video evidence verified. No penalty applied.' : 'Cancellation unverified. ₹100 penalty requires ledger reconciliation; no wallet debit was made.');
      rej.reviewedAt = new Date().toISOString();
      writeDb(db);
    }
    return rej;
  },

  // INSTANT UPI PAYOUT METHODS
  getPayouts: (driverId = null) => {
    const db = readDb();
    const list = db.payouts || [];
    if (driverId) {
      return list.filter(p => p.driverId === driverId);
    }
    return list;
  },

  createPayout: (driverId, amount, method = 'UPI payout request', upiId = null) => {
    const cleanAmount = Number(amount);
    const cleanUpiId = String(upiId || '').trim();
    if (!Number.isFinite(cleanAmount) || cleanAmount < 1 || cleanAmount > 10000 || !/^[\w.-]{2,256}@[\w.-]{2,64}$/.test(cleanUpiId)) {
      return { success: false, error: 'A valid payout amount and UPI ID are required.' };
    }
    const db = readDb();
    if (!db.payouts) db.payouts = [];
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    if (!driver) return { success: false, error: 'Driver not found.' };

    const newPayout = {
      id: `PAY_${Date.now()}`,
      driverId: driver.id,
      driverName: driver.name || null,
      driverPhone: driver.phone || null,
      upiId: cleanUpiId,
      amount: cleanAmount,
      paymentGateway: null,
      status: 'PENDING',
      transactionId: null,
      transferInitiated: false,
      requestedAt: new Date().toISOString()
    };
    db.payouts.push(newPayout);
    writeDb(db);
    return { success: true, payout: newPayout, message: `Payout request for ₹${newPayout.amount} submitted for review. No transfer has been made.` };
  },

  approvePayout: (payoutId, action, notes) => {
    const db = readDb();
    const pay = (db.payouts || []).find(p => p.id === payoutId);
    if (pay && pay.status === 'PENDING') {
      pay.status = action === 'APPROVE' ? 'APPROVED_PENDING_PROCESSING' : 'REJECTED';
      pay.adminNotes = notes || (action === 'APPROVE' ? 'Payout approved; transfer pending payment processor integration.' : 'Payout request declined by Admin.');
      pay.reviewedAt = new Date().toISOString();
      writeDb(db);
    }
    return pay;
  },

  updatePayoutTransfer: (payoutId, transfer) => {
    const db = readDb();
    const pay = (db.payouts || []).find(p => p.id === payoutId);
    if (!pay) return null;
    const mappedStatus = transfer.status === 'processed' ? 'PAID' : (transfer.status === 'reversed' ? 'TRANSFER_REVERSED' : (transfer.status === 'rejected' || transfer.status === 'failed' ? 'TRANSFER_FAILED' : 'TRANSFER_SUBMITTED'));
    if (pay.status === mappedStatus && pay.providerPayoutId === transfer.payoutId) return pay;
    if (!['APPROVED_PENDING_PROCESSING', 'TRANSFER_SUBMITTED'].includes(pay.status)) return null;
    pay.status = mappedStatus;
    pay.paymentGateway = transfer.provider || 'razorpayx';
    pay.providerPayoutId = transfer.payoutId || null;
    pay.transactionId = transfer.payoutId || null;
    pay.utr = transfer.utr || null;
    pay.transferStatus = transfer.status || 'unknown';
    pay.transferInitiated = Boolean(transfer.payoutId);
    pay.transferUpdatedAt = new Date().toISOString();
    writeDb(db);
    return pay;
  },

  getPayoutByProviderId: (providerPayoutId) => {
    const db = readDb();
    return (db.payouts || []).find(p => p.providerPayoutId === providerPayoutId) || null;
  },

  // TELEMETRY & FEEDBACK METHODS
  logTelemetry: (driverId, lat, lng, speed, heading, status) => {
    const db = readDb();
    if (!db.telemetry_logs) db.telemetry_logs = [];
    db.telemetry_logs.push({
      driverId: driverId || null,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      speed: parseFloat(speed),
      heading: parseFloat(heading),
      status: status || 'ONLINE',
      timestamp: new Date().toISOString()
    });
    // Limit log memory
    if (db.telemetry_logs.length > 500) {
      db.telemetry_logs = db.telemetry_logs.slice(-500);
    }
    writeDb(db);
    return { success: true, logged: true };
  },

  getDailyLogs: (driverId) => {
    const db = readDb();
    return (db.daily_logs || []).filter(l => !driverId || l.driverId === driverId);
  },

  recordCustomerFeedback: (tripId, driverId, customerName, rating, tags, notes, pairFuture) => {
    const db = readDb();
    if (!db.feedback) db.feedback = [];
    const entry = {
      id: `FDB_${Date.now()}`,
      tripId,
      driverId,
      customerName,
      rating: parseInt(rating, 10) || 5,
      tags: tags || [],
      notes: notes || '',
      pairFuture: !!pairFuture,
      createdAt: new Date().toISOString()
    };
    db.feedback.push(entry);
    writeDb(db);
    return { success: true, feedback: entry };
  },

  // PAYMENT GATEWAY & WALLET LEDGER APIs
  createPaymentOrder: (userId, amount, purpose = 'TRIP_FARE', bookingId = null, providerOrder = null) => {
    const db = readDb();
    if (!db.payment_transactions) db.payment_transactions = [];
    if (!providerOrder || !providerOrder.order_id) return { success: false, error: 'A confirmed payment-provider order is required.' };
    const razorpayOrderId = providerOrder.order_id;
    const newTxn = {
      id: `TXN_${Date.now()}`,
      razorpayOrderId,
      userId: userId || null,
      amount: parseFloat(amount),
      currency: 'INR',
      purpose: purpose || 'TRIP_FARE',
      bookingId: bookingId || null,
      status: 'CREATED',
      gateway: providerOrder.provider,
      keyId: providerOrder.key_id,
      createdAt: new Date().toISOString()
    };
    db.payment_transactions.push(newTxn);
    writeDb(db);
    return {
      success: true,
      order_id: razorpayOrderId,
      amount: providerOrder.amount,
      currency: 'INR',
      key_id: newTxn.keyId,
      transaction: newTxn
    };
  },

  verifyPaymentSignature: (orderId, paymentId, signature, verified = false) => {
    if (!verified) return { success: false, error: 'Payment signature has not been verified by the configured provider.' };
    const db = readDb();
    const txn = (db.payment_transactions || []).find(t => t.razorpayOrderId === orderId || t.id === orderId);
    if (txn) {
      if (txn.status === 'PAID') {
        if (txn.razorpayPaymentId !== paymentId) return { success: false, error: 'Payment transaction is already linked to a different payment.' };
        return { success: true, duplicate: true, message: 'Payment was already verified.', transaction: txn };
      }
      txn.status = 'PAID';
      txn.razorpayPaymentId = paymentId;
      txn.razorpaySignature = signature;
      txn.paidAt = new Date().toISOString();
      writeDb(db);
      return { success: true, message: 'Payment verified successfully!', transaction: txn };
    }
    return { success: false, error: 'Payment transaction record not found' };
  },

  getPaymentHistory: (userId) => {
    const db = readDb();
    return (db.payment_transactions || []).filter(t => !userId || t.userId === userId);
  },

  getPaymentForBooking: (bookingId) => {
    const db = readDb();
    return (db.payment_transactions || []).find(t => t.bookingId === bookingId && t.status === 'PAID') || null;
  },

  getPaymentByOrder: (orderId) => {
    const db = readDb();
    return (db.payment_transactions || []).find(t => t.razorpayOrderId === orderId) || null;
  },

  recordPaymentRefund: (paymentId, refund) => {
    const db = readDb();
    const txn = (db.payment_transactions || []).find(t => t.razorpayPaymentId === paymentId);
    if (!txn) return null;
    txn.refundId = refund.refundId || null;
    txn.refundStatus = refund.status || 'UNKNOWN';
    txn.refundedAmount = refund.amount || 0;
    txn.refundedAt = new Date().toISOString();
    writeDb(db);
    return txn;
  },

  // Proof of delivery is stored on the trip when a delivery completes (see deliveryStateMachine).
  getProofOfDelivery: (tripId) => {
    const db = readDb();
    const trip = (db.trips || []).find(t => t.id === tripId);
    if (!trip || !trip.proofOfDelivery) return null;
    return { tripId: trip.id, ...trip.proofOfDelivery };
  },

  // 2. LIVE DRIVER RADAR & TELEMETRY API
  getNearbyDrivers: (lat = 17.4401, lng = 78.3489, radiusKm = 10) => {
    const db = readDb();
    const drivers = db.driver_profiles || [];
    return drivers.map(d => ({
      id: d.id,
      name: d.name,
      vehicleName: d.vehicleName,
      vehicleId: d.vehicleId,
      lat: d.currentLat ?? null,
      lng: d.currentLng ?? null,
      status: d.status || 'ONLINE',
      rating: d.rating || 4.9,
      heading: null
    }));
  },

  // 3. ENTERPRISE B2B MERCHANT PORTAL APIs
  getMerchants: (merchantId = null, phone = null) => {
    const db = readDb();
    const list = db.merchants || [];

    if (merchantId) {
      return list.filter(m => m.id === merchantId);
    }
    if (phone) {
      return list.filter(m => m.phone === phone || (m.phone || '').replace(/\D/g, '') === phone.replace(/\D/g, ''));
    }
    return list;
  },

  createMerchant: (merchantData) => {
    const db = readDb();
    if (!db.merchants) db.merchants = [];
    const newMerchant = {
      id: `merch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      businessName: merchantData.businessName || merchantData.business_name || null,
      category: merchantData.category || 'Retail Store',
      contactName: merchantData.contactName || merchantData.contact_name || null,
      phone: merchantData.phone || null,
      email: merchantData.email || null,
      gstin: merchantData.gstin || null,
      city: merchantData.city || 'Hyderabad',
      address: merchantData.address || null,
      storefrontPhotoUrl: merchantData.storefrontPhotoUrl || merchantData.storefront_photo || null,
      locationPhotoUrl: merchantData.locationPhotoUrl || merchantData.location_photo || null,
      gstinDocUrl: merchantData.gstinDocUrl || merchantData.gstin_doc || null,
      verificationStatus: 'PENDING_REVIEW',
      creditLimit: parseInt(merchantData.creditLimit || 50000, 10),
      creditUsed: 0,
      status: 'ACTIVE',
      createdAt: new Date().toISOString()
    };
    db.merchants.push(newMerchant);
    writeDb(db);
    return newMerchant;
  },

  getMerchantOrders: (merchantId = null, monthFilter = null) => {
    const db = readDb();
    const trips = db.trips || [];
    const merchant = (db.merchants || []).find(item => item.id === merchantId);
    if (!merchant) return { count: 0, completedCount: 0, totalSpend: 0, orders: [] };
    let merchantTrips = trips.filter(trip => trip.merchantId === merchantId || trip.merchant_id === merchantId).map(trip => ({
      ...trip,
      pod: trip.proofOfDelivery ? { tripId: trip.id, ...trip.proofOfDelivery } : null
    }));

    if (monthFilter) {
      merchantTrips = merchantTrips.filter(t => (t.createdAt || '').startsWith(monthFilter));
    }

    const totalSpend = merchantTrips.reduce((sum, t) => sum + (t.totalFare || 0), 0);
    const completedCount = merchantTrips.filter(t => t.status === 'DELIVERED' || t.status === 'COMPLETED').length;

    return {
      count: merchantTrips.length,
      completedCount,
      totalSpend,
      orders: merchantTrips
    };
  },

  calculateVehicleSavings: (monthlyTripsCount = 20, vehicleCategory = 'v_ace') => {
    const trips = parseInt(monthlyTripsCount, 10) || 20;
    
    // Ownership Cost Breakdown for Private Delivery Truck (Monthly)
    const vehicleEmi = 14500; // Monthly Loan EMI for Tata Ace / Bolero
    const driverSalary = 18000; // Full-time Driver Monthly Salary
    const fuelMaintenance = 15000; // Fuel & Maintenance per Month
    const insurancePermits = 2500; // Insurance & Commercial Permits
    const totalPrivateTruckCost = vehicleEmi + driverSalary + fuelMaintenance + insurancePermits; // ₹50,000 / month

    // VAAYU On-Demand Pay-per-trip Cost
    let avgTripFare = 350; // Ace 7ft base average
    if (vehicleCategory === 'v_3w') avgTripFare = 200;
    if (vehicleCategory === 'v_pickup_8ft') avgTripFare = 450;
    if (vehicleCategory === 'v_14ft') avgTripFare = 850;

    const totalVaayuCost = trips * avgTripFare;
    const netMonthlySavings = Math.max(0, totalPrivateTruckCost - totalVaayuCost);
    const percentageSaved = Math.round((netMonthlySavings / totalPrivateTruckCost) * 100);

    return {
      monthlyTripsCount: trips,
      vehicleCategory,
      privateOwnershipCost: totalPrivateTruckCost,
      vaayuOnDemandCost: totalVaayuCost,
      netMonthlySavings,
      percentageSaved
    };
  },

  createBatchBookings: (merchantId, bookingsList = [], scheduleRun = null) => {
    const db = readDb();
    if (!db.trips) db.trips = [];
    const createdTrips = [];
    const merchant = (db.merchants || []).find(m => m.id === merchantId);
    if (!merchant) return { success: false, error: 'Merchant account not found.', count: 0, totalFare: 0, trips: [] };
    const schedule = scheduleRun?.scheduleId ? (db.merchant_schedules || []).find(item => item.id === scheduleRun.scheduleId && item.merchantId === merchantId && item.status === 'ACTIVE') : null;
    if (scheduleRun?.scheduleId && (!schedule || schedule.lastRunDate === scheduleRun.runDate)) {
      return { success: false, error: 'This scheduled run is no longer due or has already been processed.', count: 0, totalFare: 0, trips: [] };
    }
    if (!Array.isArray(bookingsList) || bookingsList.length === 0 || bookingsList.length > 500) {
      return { success: false, error: 'Submit between 1 and 500 bookings per batch.', count: 0, totalFare: 0, trips: [] };
    }

    let totalBatchFare = 0;
    const normalizedBookings = bookingsList.map((booking, idx) => {
      const fare = Number(booking.fare);
      if (!booking.pickupAddress || !booking.dropAddress || !Number.isFinite(fare) || fare <= 0) {
        throw new Error(`Booking ${idx + 1} requires pickup, destination, and a positive fare.`);
      }
      return { ...booking, fare };
    });
    const requestedTotal = normalizedBookings.reduce((sum, booking) => sum + booking.fare, 0);
    const creditLimit = Number(merchant.creditLimit) || 0;
    const creditUsed = Number(merchant.creditUsed) || 0;
    if (creditLimit > 0 && creditUsed + requestedTotal > creditLimit) {
      return { success: false, error: `This batch exceeds the remaining corporate credit limit of ₹${Math.max(0, creditLimit - creditUsed).toFixed(2)}.`, count: 0, totalFare: 0, trips: [] };
    }
    normalizedBookings.forEach((b, idx) => {
      const fare = b.fare;
      totalBatchFare += fare;
      const trip = {
        id: `TRIP_BATCH_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${idx+1}`,
        trackingToken: crypto.randomBytes(32).toString('base64url'),
        merchantId: merchant.id,
        merchant_id: merchant.id,
        scheduleId: scheduleRun?.scheduleId || null,
        businessOrderId: b.businessOrderId || null,
        poReference: b.poReference || null,
        requiredSlaTime: b.requiredSlaTime || null,
        senderName: b.merchantName || merchant.businessName || 'B2B Corporate Client',
        senderPhone: merchant.phone || null,
        receiverName: b.recipientName || 'Receiving Contact',
        receiverPhone: b.recipientPhone || null,
        pickupAddress: b.pickupAddress || 'Kukatpally Industrial Estate, Hyderabad',
        pickupLat: Number.isFinite(Number(b.pickupLat)) ? Number(b.pickupLat) : 17.4850,
        pickupLng: Number.isFinite(Number(b.pickupLng)) ? Number(b.pickupLng) : 78.4041,
        dropAddress: b.dropAddress || `Store Branch Location #${idx+1}, Hyderabad`,
        dropLat: Number.isFinite(Number(b.dropLat)) ? Number(b.dropLat) : 17.4401,
        dropLng: Number.isFinite(Number(b.dropLng)) ? Number(b.dropLng) : 78.3489,
        goodsCategory: b.goodsCategory || b.itemDescription || 'Commercial Goods',
        goodsNotes: b.instructions || '',
        helperCount: Number(b.helperCount) || 0,
        vehicleName: b.vehicleName || 'VAAYU Ace (Tata Ace 7ft)',
        vehicleId: b.vehicleId || 'v_ace',
        totalFare: fare,
        fareBreakdown: b.fareBreakdown || null,
        distanceKm: Number(b.distanceKm) || null,
        durationMin: Number(b.durationMin) || null,
        requiredSlaTime: b.requiredSlaTime || null,
        paymentMode: 'POSTPAID_CREDIT_LINE',
        status: 'CREATED',
        deliveryOtp: String(crypto.randomInt(1000, 10000)),
        trackingToken: crypto.randomBytes(32).toString('base64url'),
        version: 1,
        createdAt: new Date().toISOString()
      };
      db.trips.push(trip);
      createdTrips.push(trip);
    });

    // Update merchant credit used
    if (merchant) {
      merchant.creditUsed = (merchant.creditUsed || 0) + totalBatchFare;
    }

    if (schedule) {
      schedule.lastRunDate = scheduleRun.runDate;
      schedule.lastRunAt = new Date().toISOString();
      if (schedule.type === 'ONE_TIME') schedule.status = 'COMPLETED';
    }

    writeDb(db);
    return { success: true, count: createdTrips.length, totalFare: totalBatchFare, trips: createdTrips };
  },

  parseCsvOrders: (csvContent = '') => {
    if (typeof csvContent !== 'string') {
      if (Array.isArray(csvContent)) {
        const validRows = [];
        const invalidRows = [];
        csvContent.forEach((row, idx) => {
          const errors = [];
          if (!row.pickupAddress || String(row.pickupAddress).trim().length < 3) errors.push('Missing or invalid pickup address');
          if (!row.dropAddress || String(row.dropAddress).trim().length < 3) errors.push('Missing or invalid drop address');
          if (!row.recipientPhone || !/^\+?\d{10,12}$/.test(String(row.recipientPhone).replace(/\s+/g, ''))) errors.push('Invalid 10-digit phone number');
          if (!row.weightKg || isNaN(parseFloat(row.weightKg)) || parseFloat(row.weightKg) <= 0) errors.push('Invalid item weight (kg)');

          const parsedRow = {
            rowNumber: idx + 1,
            pickupAddress: row.pickupAddress || '',
            dropAddress: row.dropAddress || '',
            recipientPhone: row.recipientPhone || '',
            weightKg: parseFloat(row.weightKg) || 0,
            vehicleCategory: row.vehicleCategory || row.vehicleType || 'v_ace',
            errors
          };

          if (errors.length === 0) validRows.push(parsedRow);
          else invalidRows.push(parsedRow);
        });
        return {
          success: true,
          summary: { total: csvContent.length, validCount: validRows.length, invalidCount: invalidRows.length },
          validRows,
          invalidRows
        };
      }
    }

    const lines = String(csvContent).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) {
      return { success: false, error: 'Empty CSV input file provided', summary: { total: 0, validCount: 0, invalidCount: 0 }, validRows: [], invalidRows: [] };
    }

    let startIdx = 0;
    const firstLine = lines[0].toLowerCase();
    if (firstLine.includes('pickup') || firstLine.includes('drop') || firstLine.includes('phone') || firstLine.includes('address')) {
      startIdx = 1;
    }

    const validRows = [];
    const invalidRows = [];

    for (let i = startIdx; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      const pickupAddress = cols[0] || '';
      const dropAddress = cols[1] || '';
      const recipientPhone = cols[2] || '';
      const weightKg = parseFloat(cols[3]) || 0;
      const vehicleCategory = cols[4] || 'v_ace';

      const errors = [];
      if (!pickupAddress || pickupAddress.length < 3) errors.push('Missing pickup address');
      if (!dropAddress || dropAddress.length < 3) errors.push('Missing drop address');
      if (!recipientPhone || !/^\+?\d{10,12}$/.test(recipientPhone.replace(/\s+/g, ''))) errors.push('Invalid 10-digit phone number');
      if (isNaN(weightKg) || weightKg <= 0) errors.push('Invalid payload weight (kg)');

      const rowObj = {
        rowNumber: i + 1,
        pickupAddress,
        dropAddress,
        recipientPhone,
        weightKg,
        vehicleCategory,
        errors
      };

      if (errors.length === 0) validRows.push(rowObj);
      else invalidRows.push(rowObj);
    }

    return {
      success: true,
      summary: { total: lines.length - startIdx, validCount: validRows.length, invalidCount: invalidRows.length },
      validRows,
      invalidRows
    };
  },

  createSchedule: (merchantId, scheduleData = {}) => {
    const db = readDb();
    if (!merchantId || !(db.merchants || []).some(merchant => merchant.id === merchantId)) return { success: false, error: 'Merchant account not found.' };
    if (!db.merchant_schedules) db.merchant_schedules = [];

    const schedule = {
      id: `SCHED_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      merchantId,
      type: scheduleData.type || 'RECURRING',
      daysOfWeek: scheduleData.daysOfWeek || ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
      timeOfDay: scheduleData.timeOfDay || '08:00',
      futureDate: scheduleData.futureDate || null,
      vehicleType: scheduleData.vehicleType || 'v_ace',
      vehicleName: scheduleData.vehicleName || 'VAAYU Ace (Tata Ace 7ft)',
      pickupAddress: scheduleData.pickupAddress || 'Kukatpally Hardware Market, Hyderabad',
      pickupLat: Number.isFinite(Number(scheduleData.pickupLat)) ? Number(scheduleData.pickupLat) : 17.4850,
      pickupLng: Number.isFinite(Number(scheduleData.pickupLng)) ? Number(scheduleData.pickupLng) : 78.4041,
      dropAddress: scheduleData.dropAddress || 'Retail Store Branch #1, Hyderabad',
      dropLat: Number.isFinite(Number(scheduleData.dropLat)) ? Number(scheduleData.dropLat) : 17.4401,
      dropLng: Number.isFinite(Number(scheduleData.dropLng)) ? Number(scheduleData.dropLng) : 78.3489,
      itemDescription: scheduleData.itemDescription || 'Daily Commercial Restock Freight',
      status: 'ACTIVE',
      autoDispatchEnabled: true,
      createdAt: new Date().toISOString()
    };

    db.merchant_schedules.push(schedule);
    writeDb(db);
    return { success: true, schedule };
  },

  getMerchantStaff: (merchantId) => {
    const db = readDb();
    const merchant = (db.merchants || []).find(item => item.id === merchantId);
    return merchant && Array.isArray(merchant.staff) ? merchant.staff : [];
  },

  addMerchantStaff: (merchantId, staffData = {}) => {
    const db = readDb();
    const merchant = (db.merchants || []).find(item => item.id === merchantId);
    if (!merchant) return { success: false, error: 'Merchant account not found.' };
    const name = String(staffData.name || '').trim();
    const phone = String(staffData.phone || '').replace(/\D/g, '').slice(-10);
    if (name.length < 2 || phone.length !== 10) return { success: false, error: 'Enter a name and valid 10-digit mobile number.' };
    if (!Array.isArray(merchant.staff)) merchant.staff = [];
    if (merchant.staff.some(item => String(item.phone || '').replace(/\D/g, '').slice(-10) === phone)) {
      return { success: false, error: 'This phone number is already registered for the business.' };
    }
    const staff = { id: `stf_${crypto.randomUUID()}`, name, phone, role: staffData.role || 'STORE_MANAGER', branch: staffData.branch || 'All Branches', createdAt: new Date().toISOString() };
    merchant.staff.push(staff);
    writeDb(db);
    return { success: true, staff };
  },

  getMerchantSchedules: (merchantId = null) => {
    const db = readDb();
    const list = db.merchant_schedules || [];
    return list.filter(s => s.merchantId === merchantId || merchantId === 'all');
  },

  getDueMerchantSchedules: (now = new Date()) => {
    const db = readDb();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).map(part => [part.type, part.value]));
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    const currentTime = `${parts.hour}:${parts.minute}`;
    return (db.merchant_schedules || []).filter(schedule => {
      if (schedule.status !== 'ACTIVE' || schedule.autoDispatchEnabled !== true || !schedule.futureDate || schedule.futureDate > dateKey || schedule.lastRunDate === dateKey) return false;
      if (String(schedule.timeOfDay || '08:00') > currentTime) return false;
      if (schedule.type === 'ONE_TIME') return schedule.futureDate <= dateKey;
      const pattern = (schedule.daysOfWeek || []).join(' ');
      if (/daily|mon.?sat/i.test(pattern)) return parts.weekday !== 'Sun';
      const allowedDays = pattern.match(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/g) || [];
      return allowedDays.includes(parts.weekday);
    }).map(schedule => ({ ...schedule, dueDate: dateKey }));
  },

  cancelSchedule: (merchantId, scheduleId) => {
    const db = readDb();
    if (!db.merchant_schedules) db.merchant_schedules = [];
    const schedule = db.merchant_schedules.find(s => s.id === scheduleId && s.merchantId === merchantId);
    if (schedule) {
      schedule.status = 'CANCELLED';
      writeDb(db);
      return { success: true, message: 'Schedule cancelled successfully', schedule };
    }
    return { success: false, error: 'Schedule not found' };
  },

  // 4. FLEET OWNER VENDOR PORTAL APIs
  getFleetOwners: () => {
    const db = readDb();
    return db.fleet_owners || [];
  },

  assignDriverToVehicle: (ownerId, driverId, vehicleId) => {
    const db = readDb();
    const driver = (db.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
    const vehicle = (db.vehicle_categories || []).find(item => item.id === vehicleId);
    if (!driver) return { success: false, error: 'Driver not found.' };
    if (!vehicle) return { success: false, error: 'Choose a valid vehicle type.' };
    if (driver.fleetOwnerId && driver.fleetOwnerId !== ownerId) return { success: false, error: 'Driver is outside this fleet.' };
    if (driver) {
      driver.vehicleId = vehicleId;
      driver.vehicleName = vehicle.name;
      driver.fleetOwnerId = ownerId;
      writeDb(db);
    }
    return { success: true, message: 'Driver assigned to fleet vehicle successfully!' };
  },

  // 5. DYNAMIC WAITING TIME CALCULATION & ROUTE OPTIMIZATION
  calculateWaitingTimeFee: (waitingMinutes = 0, vehicleCategory = 'V_TATA_ACE') => {
    const freeMinutes = 15;
    const billableMinutes = Math.max(0, waitingMinutes - freeMinutes);
    const ratePerMin = vehicleCategory.includes('17FT') || vehicleCategory.includes('14FT') ? 5 : 2;
    const totalWaitingFee = billableMinutes * ratePerMin;
    return {
      waitingMinutes,
      freeMinutes,
      billableMinutes,
      ratePerMin,
      totalWaitingFee
    };
  },

  // 6. SOS EMERGENCY PANIC & DRIVER SAFETY ALERTS
  triggerSosEmergency: (driverId, tripId, lat, lng) => {
    const db = readDb();
    if (!db.sos_alerts) db.sos_alerts = [];
    // Never invent a driver or trip: an SOS must name the real people and order involved.
    const driver = (db.driver_profiles || []).find(d => d.id === driverId) || {};
    const alert = {
      id: `SOS_${Date.now()}`,
      driverId: driverId || null,
      driverName: driver.name || null,
      driverPhone: driver.phone || null,
      tripId: tripId || null,
      lat: parseFloat(lat) || 17.4850,
      lng: parseFloat(lng) || 78.4041,
      status: 'CRITICAL_DISPATCH_TRIGGERED',
      notifiedContacts: ['Telangana Police Control (112)', 'Vaayu Safety Response Center'],
      triggeredAt: new Date().toISOString()
    };
    db.sos_alerts.push(alert);
    writeDb(db);
    return { success: true, message: 'SOS Panic Signal Sent to Emergency Services (112) & Ops Room!', alert };
  },

  getSosAlerts: () => {
    const db = readDb();
    return db.sos_alerts || [];
  },

  createSupportTicket: (ticketData) => {
    const db = readDb();
    if (!db.support_tickets) db.support_tickets = [];
    const newTicket = {
      id: `TICK_${crypto.randomUUID()}`,
      customerId: ticketData.customerId || null,
      customerName: ticketData.customerName || 'Customer',
      customerPhone: ticketData.customerPhone || null,
      tripId: ticketData.tripId || null,
      issueCategory: ticketData.category || 'AI Support Escalation',
      subject: ticketData.subject || 'Customer requested live human support agent',
      status: 'OPEN',
      priority: 'HIGH',
      assignedAgent: null,
      createdAt: new Date().toISOString()
    };
    db.support_tickets.push(newTicket);
    writeDb(db);
    return newTicket;
  }
};





