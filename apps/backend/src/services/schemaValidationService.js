/**
 * VAAYU Enterprise Logistics Platform
 * Enterprise Payload & Schema Validation Middleware
 *
 * Provides strict, declarative schema validation for all API routes,
 * ensuring high-quality data integrity and descriptive error messages.
 */

class SchemaValidationService {
  /**
   * Validate trip creation payload
   * @param {Object} data 
   * @returns {Object} { isValid, errors, cleanData }
   */
  validateTripCreate(data = {}) {
    const errors = [];

    const pickupLat = parseFloat(data.pickupLat);
    const pickupLng = parseFloat(data.pickupLng);
    const dropLat = parseFloat(data.dropLat);
    const dropLng = parseFloat(data.dropLng);

    if (isNaN(pickupLat) || pickupLat < -90 || pickupLat > 90) {
      errors.push({ field: 'pickupLat', message: 'pickupLat must be a valid latitude between -90 and 90' });
    }
    if (isNaN(pickupLng) || pickupLng < -180 || pickupLng > 180) {
      errors.push({ field: 'pickupLng', message: 'pickupLng must be a valid longitude between -180 and 180' });
    }
    if (isNaN(dropLat) || dropLat < -90 || dropLat > 90) {
      errors.push({ field: 'dropLat', message: 'dropLat must be a valid latitude between -90 and 90' });
    }
    if (isNaN(dropLng) || dropLng < -180 || dropLng > 180) {
      errors.push({ field: 'dropLng', message: 'dropLng must be a valid longitude between -180 and 180' });
    }

    const validVehicles = ['v_2w', 'v_3w', 'v_ace', 'v_8ft', 'v_etruck'];
    const vehicleId = data.vehicleId || 'v_ace';
    if (data.vehicleId && !validVehicles.includes(data.vehicleId)) {
      errors.push({ field: 'vehicleId', message: `vehicleId must be one of: ${validVehicles.join(', ')}` });
    }

    return {
      isValid: errors.length === 0,
      errors,
      cleanData: {
        pickupLat: isNaN(pickupLat) ? 17.4850 : pickupLat,
        pickupLng: isNaN(pickupLng) ? 78.4041 : pickupLng,
        dropLat: isNaN(dropLat) ? 17.4401 : dropLat,
        dropLng: isNaN(dropLng) ? 78.3489 : dropLng,
        vehicleId,
        helperCount: Math.max(0, parseInt(data.helperCount || 0, 10)),
        extraDropsCount: Math.max(0, parseInt(data.extraDropsCount || 0, 10)),
        waitingTimeMinutes: Math.max(0, parseInt(data.waitingTimeMinutes || 0, 10)),
        driverTip: Math.max(0, parseInt(data.driverTip || 0, 10))
      }
    };
  }

  /**
   * Validate mobile phone number
   * @param {string} phone 
   * @returns {Object} { isValid, cleanPhone, error }
   */
  validatePhone(phone) {
    if (!phone || typeof phone !== 'string') {
      return { isValid: false, error: 'Mobile phone number is required' };
    }
    const cleanDigits = phone.replace(/\D/g, '');
    if (cleanDigits.length < 10) {
      return { isValid: false, error: 'Mobile phone number must contain at least 10 digits' };
    }
    return { isValid: true, cleanPhone: cleanDigits.slice(-10) };
  }
}

const schemaValidationService = new SchemaValidationService();

module.exports = {
  SchemaValidationService,
  schemaValidationService
};
