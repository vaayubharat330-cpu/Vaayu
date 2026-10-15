const { Pool } = require('pg');
const { metricsService } = require('../services/metricsService');

/**
 * PostgreSQL connection pool backed by the real `pg` driver.
 *
 * Connects with DATABASE_URL, or the PG* environment variables when it is unset.
 * There is no in-memory fallback: if the server is unreachable, queries reject.
 */
class PostgresPool {
  constructor(config = {}) {
    const connectionString = config.connectionString || process.env.DATABASE_URL;
    const poolConfig = connectionString
      ? { connectionString }
      : {
          host: config.host || process.env.PGHOST || 'localhost',
          port: parseInt(config.port || process.env.PGPORT || '5432', 10),
          database: config.database || process.env.PGDATABASE || 'vaayu',
          user: config.user || process.env.PGUSER || 'postgres',
          password: config.password || process.env.PGPASSWORD,
        };
    if (process.env.PGSSL === 'true' || config.ssl) {
      poolConfig.ssl = { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' };
    }
    poolConfig.max = config.max || parseInt(process.env.PGPOOL_MAX || '10', 10);
    poolConfig.idleTimeoutMillis = 30000;
    poolConfig.connectionTimeoutMillis = config.connectionTimeoutMillis || parseInt(process.env.PGCONNECT_TIMEOUT_MS || '5000', 10);

    this.pool = new Pool(poolConfig);
    this.pool.on('error', (err) => {
      metricsService.increment('postgres_pool_errors_total');
      console.error('[postgres] idle client error:', err.message);
    });
  }

  async query(sql, params = []) {
    const start = Date.now();
    try {
      metricsService.increment('postgres_queries_total');
      const res = await this.pool.query(sql, params);
      metricsService.recordLatency('postgres_query_latency', Date.now() - start);
      return res;
    } catch (err) {
      metricsService.increment('postgres_query_errors_total');
      throw err;
    }
  }

  /**
   * Run several statements on one leased PostgreSQL connection.
   * This is mandatory for BEGIN/COMMIT transaction scopes; Pool.query()
   * may otherwise dispatch successive statements to different connections.
   */
  async withTransaction(work) {
    const client = await this.pool.connect();
    const start = Date.now();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      metricsService.recordLatency('postgres_transaction_latency', Date.now() - start);
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        metricsService.increment('postgres_transaction_rollback_errors_total');
        console.error('[postgres] transaction rollback failed:', rollbackErr.message);
      }
      metricsService.increment('postgres_transaction_failures_total');
      throw err;
    } finally {
      client.release();
    }
  }

  async connect() {
    return await this.pool.connect();
  }

  async end() {
    await this.pool.end();
  }
}

module.exports = {
  PostgresPool,
};
