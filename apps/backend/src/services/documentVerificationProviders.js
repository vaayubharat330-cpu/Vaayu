'use strict';

/**
 * Provider-neutral authoritative document verification boundary.
 *
 * VAAYU deliberately does not scrape government portals. Providers are
 * adapters and remain disabled until credentials, commercial approval and
 * legal/consent requirements are satisfied. This lets the verification
 * engine become plug-and-play without changing the KYC decision model.
 */

const SUPPORTED_DOCUMENT_TYPES = Object.freeze([
  'RC',
  'DRIVING_LICENSE',
  'INSURANCE',
  'PAN',
  'AADHAAR',
]);

const PROVIDER_STATES = Object.freeze({
  DISABLED: 'DISABLED',
  CONFIGURED: 'CONFIGURED',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

class DocumentVerificationProvider {
  constructor({ name, supportedTypes = [], enabled = false } = {}) {
    this.name = name;
    this.supportedTypes = new Set(supportedTypes);
    this.enabled = enabled;
  }

  supports(documentType) {
    return this.enabled && this.supportedTypes.has(documentType);
  }

  async verify() {
    throw new Error(`Provider ${this.name} does not implement verify()`);
  }
}

/**
 * Generic HTTP adapter contract. The endpoint/credentials are intentionally
 * environment driven. No provider URL or secret is hard-coded into VAAYU.
 */
class HttpDocumentVerificationProvider extends DocumentVerificationProvider {
  constructor({ name, baseUrl, supportedTypes, enabled, request }) {
    super({ name, supportedTypes, enabled });
    this.baseUrl = baseUrl || null;
    this.request = request;
  }

  async verify(input) {
    if (!this.enabled || !this.baseUrl) {
      return { state: 'UNAVAILABLE', provider: this.name };
    }
    if (typeof this.request !== 'function') {
      return { state: 'UNAVAILABLE', provider: this.name };
    }
    return this.request(input);
  }
}

/**
 * Registry is intentionally provider-neutral. Recommended future adapters:
 * - DigiLocker/API Setu: strongest first-party route for consented issuer docs.
 * - MoRTH Vahan/Sarathi/API Setu transport collection: authoritative RC/DL
 *   verification when VAAYU receives the required approval and credentials.
 * - UIDAI-authorized/offline e-KYC: Aadhaar only, subject to the applicable
 *   requesting/offline-verification entity framework and user consent.
 * - Authorized PAN provider/API Setu collection: PAN verification.
 *
 * These are alternatives, not fallbacks that silently weaken verification.
 */
class DocumentVerificationProviderRegistry {
  constructor(providers = []) {
    this.providers = providers.filter(Boolean);
  }

  forDocumentType(documentType) {
    return this.providers.filter((provider) => provider.supports(documentType));
  }

  async verify(documentType, input) {
    const providers = this.forDocumentType(documentType);
    if (providers.length === 0) {
      return {
        state: 'PENDING_PARTNER_ACCESS',
        provider: null,
        reason: 'No authoritative provider is configured for this document type.',
      };
    }

    const attempts = [];
    for (const provider of providers) {
      try {
        const result = await provider.verify(input);
        attempts.push({ provider: provider.name, result });
        if (result && ['VERIFIED_MATCH', 'VERIFIED_REJECTED'].includes(result.state)) {
          return { ...result, provider: result.provider || provider.name, attempts };
        }
      } catch (error) {
        attempts.push({
          provider: provider.name,
          result: { state: 'UNAVAILABLE', errorCode: error.code || 'PROVIDER_ERROR' },
        });
      }
    }

    return {
      state: 'UNAVAILABLE',
      provider: attempts[0]?.provider || null,
      attempts,
    };
  }
}

function buildDefaultProviderRegistry() {
  const digilockerEnabled = process.env.DOCUMENT_PROVIDER_DIGILOCKER_ENABLED === 'true';
  const morthEnabled = process.env.DOCUMENT_PROVIDER_MORTH_ENABLED === 'true';
  const panEnabled = process.env.DOCUMENT_PROVIDER_PAN_ENABLED === 'true';
  const aadhaarEnabled = process.env.DOCUMENT_PROVIDER_AADHAAR_ENABLED === 'true';

  return new DocumentVerificationProviderRegistry([
    new HttpDocumentVerificationProvider({
      name: 'DIGILOCKER_API_SETU',
      baseUrl: process.env.DIGILOCKER_API_BASE_URL,
      supportedTypes: ['RC', 'DRIVING_LICENSE', 'PAN', 'AADHAAR'],
      enabled: digilockerEnabled,
    }),
    new HttpDocumentVerificationProvider({
      name: 'MORTH_API_SETU',
      baseUrl: process.env.MORTH_API_BASE_URL,
      supportedTypes: ['RC', 'DRIVING_LICENSE', 'INSURANCE'],
      enabled: morthEnabled,
    }),
    new HttpDocumentVerificationProvider({
      name: 'PAN_AUTHORIZED_PROVIDER',
      baseUrl: process.env.PAN_VERIFICATION_API_BASE_URL,
      supportedTypes: ['PAN'],
      enabled: panEnabled,
    }),
    new HttpDocumentVerificationProvider({
      name: 'UIDAI_AUTHORIZED',
      baseUrl: process.env.AADHAAR_VERIFICATION_API_BASE_URL,
      supportedTypes: ['AADHAAR'],
      enabled: aadhaarEnabled,
    }),
  ]);
}

module.exports = {
  SUPPORTED_DOCUMENT_TYPES,
  PROVIDER_STATES,
  DocumentVerificationProvider,
  HttpDocumentVerificationProvider,
  DocumentVerificationProviderRegistry,
  buildDefaultProviderRegistry,
};
