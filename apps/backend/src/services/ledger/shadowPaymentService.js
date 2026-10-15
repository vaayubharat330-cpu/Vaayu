'use strict';

/**
 * VAAYU SHADOW PAYMENT VERIFIER (Phase F.2)
 * 
 * Executes transactions against both the legacy/JSON ledger and the new
 * PostgreSQL transactional ledger, verifying 100% parity before authority cutover.
 */
class ShadowPaymentVerifier {
  constructor({ primaryService, shadowService, logger = console } = {}) {
    this.primary = primaryService;
    this.shadow = shadowService;
    this.logger = logger;
    this.metrics = {
      totalCompared: 0,
      matches: 0,
      mismatches: 0,
      shadowErrors: 0
    };
  }

  _compareResults(primaryRes, shadowRes) {
    if (!primaryRes && !shadowRes) return true;
    if (!primaryRes || !shadowRes) return false;

    // Both succeeded
    if (primaryRes.success && shadowRes.success) {
      const stateMatch = primaryRes.status === shadowRes.status || primaryRes.state === shadowRes.state;
      const replayMatch = Boolean(primaryRes.idempotentReplay) === Boolean(shadowRes.idempotentReplay);
      const amountMatch = (primaryRes.amountPaise === undefined || primaryRes.amountPaise === shadowRes.amountPaise);
      return stateMatch && replayMatch && amountMatch;
    }

    // Both failed
    if (!primaryRes.success && !shadowRes.success) {
      const pCode = primaryRes.error?.code || primaryRes.code;
      const sCode = shadowRes.error?.code || shadowRes.code;
      return pCode === sCode;
    }

    return false;
  }

  async executeWithShadow(opName, primaryFn, shadowFn) {
    const primaryResult = await primaryFn();
    this.metrics.totalCompared++;

    if (this.shadow && shadowFn) {
      try {
        const shadowResult = await shadowFn();
        const matches = this._compareResults(primaryResult, shadowResult);
        if (matches) {
          this.metrics.matches++;
        } else {
          this.metrics.mismatches++;
          this.logger.warn(`[SHADOW_MISMATCH] ${opName} produced mismatched results`, {
            primary: primaryResult,
            shadow: shadowResult
          });
        }
      } catch (shadowErr) {
        this.metrics.shadowErrors++;
        // If primary failed with same error code, count as match
        const pCode = primaryResult?.error?.code || primaryResult?.code;
        if (!primaryResult?.success && pCode && shadowErr.code === pCode) {
          this.metrics.matches++;
        } else {
          this.logger.warn(`[SHADOW_ERROR] ${opName} shadow execution threw`, {
            primary: primaryResult,
            shadowError: shadowErr.message,
            code: shadowErr.code
          });
        }
      }
    }

    return primaryResult;
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = {
  ShadowPaymentVerifier
};
