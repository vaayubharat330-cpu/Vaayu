'use strict';

/**
 * Durable reporting extensions for PostgresLedgerRepository.
 * Kept separate from the transactional mutation implementation so reporting cannot
 * accidentally fall back to the process-local PaymentStateMachine in production.
 */
function installPostgresLedgerReporting(PostgresLedgerRepository) {
  if (PostgresLedgerRepository.prototype.queryTransactions) return;

  PostgresLedgerRepository.prototype.queryTransactions = async function queryTransactions(filters = {}) {
    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('$N', `$${params.length}`));
    };

    if (filters.tripId) add('trip_id = $N', String(filters.tripId));
    if (filters.state) add('state = $N', String(filters.state));
    if (filters.customerId) add('customer_id = $N', String(filters.customerId));
    if (filters.driverId) add('driver_id = $N', String(filters.driverId));

    const limit = Math.min(200, Math.max(1, Number.parseInt(filters.limit || 50, 10) || 50));
    const offset = Math.max(0, Number.parseInt(filters.offset || 0, 10) || 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM payment_transactions ${whereSql}`,
      params
    );
    const rows = await this.pool.query(
      `SELECT * FROM payment_transactions ${whereSql} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return {
      total: Number(count.rows[0]?.count || 0),
      count: rows.rows.length,
      limit,
      offset,
      transactions: rows.rows.map(row => this._mapPayment(row))
    };
  };

  PostgresLedgerRepository.prototype.getFinancialStats = async function getFinancialStats() {
    const [states, settled, escrowed] = await Promise.all([
      this.pool.query('SELECT state, COUNT(*)::int AS count, COALESCE(SUM(amount_paise),0) AS amount FROM payment_transactions GROUP BY state'),
      this.pool.query("SELECT COALESCE(SUM(amount_paise),0) AS gmv, COALESCE(SUM(commission_paise),0) AS commission, COALESCE(SUM(gst_paise),0) AS gst, COALESCE(SUM(driver_earnings_paise),0) AS driver_earnings FROM payment_transactions WHERE state = 'SETTLED'"),
      this.pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(escrow_paise),0) AS escrow FROM payment_transactions WHERE state = 'ESCROWED'")
    ]);

    const byState = {};
    for (const row of states.rows) {
      byState[row.state] = { count: Number(row.count), amountPaise: Number(row.amount) };
    }

    const t = settled.rows[0] || {};
    const e = escrowed.rows[0] || {};
    return {
      byState,
      settledGmvPaise: Number(t.gmv || 0),
      commissionPaise: Number(t.commission || 0),
      gstPaise: Number(t.gst || 0),
      driverEarningsPaise: Number(t.driver_earnings || 0),
      escrowedCount: Number(e.count || 0),
      escrowedPaise: Number(e.escrow || 0),
      generatedAt: new Date().toISOString()
    };
  };
}

module.exports = { installPostgresLedgerReporting };
