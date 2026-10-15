// Pure request/response helpers shared by the HTTP layer.
// These read only their arguments, process.env, or the role tables below. No database access.
const zlib = require('zlib');

const ADMIN_ROLE_GRANTS = {
  ADMIN: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'],
  SUPER_ADMIN: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'],
  FLEET_ADMIN: ['FLEET_ADMIN'],
  DISPATCH_OPERATOR: ['DISPATCH_OPERATOR'],
  SUPPORT_AGENT: ['SUPPORT_AGENT'],
  MERCHANT_ADMIN: ['MERCHANT_ADMIN', 'MERCHANT', 'MERCHANT_DISPATCHER', 'MERCHANT_AUDITOR'],
  MERCHANT: ['MERCHANT', 'MERCHANT_ADMIN', 'MERCHANT_DISPATCHER', 'MERCHANT_AUDITOR'],
  MERCHANT_DISPATCHER: ['MERCHANT_DISPATCHER'],
  MERCHANT_AUDITOR: ['MERCHANT_AUDITOR']
};
const ADMIN_PERMISSIONS = {
  ADMIN: ['ANALYTICS', 'DISPATCH', 'ZONES', 'DRIVERS', 'DRIVER_TELEMETRY', 'DRIVER_BATCHING', 'CANCELLATIONS', 'PAYOUTS', 'KYC_AUDIT', 'CUSTOMERS', 'PRICING', 'ROLLOUTS', 'SUPPORT', 'DISPUTES', 'AUTOMATIONS', 'BROADCASTS', 'ADVERTISEMENTS', 'EXPORTS', 'SMS_GATEWAY'],
  SUPER_ADMIN: ['ANALYTICS', 'DISPATCH', 'ZONES', 'DRIVERS', 'DRIVER_TELEMETRY', 'DRIVER_BATCHING', 'CANCELLATIONS', 'PAYOUTS', 'KYC_AUDIT', 'CUSTOMERS', 'PRICING', 'ROLLOUTS', 'SUPPORT', 'DISPUTES', 'AUTOMATIONS', 'BROADCASTS', 'ADVERTISEMENTS', 'EXPORTS', 'SMS_GATEWAY'],
  FLEET_ADMIN: ['DRIVERS', 'DRIVER_TELEMETRY', 'DRIVER_BATCHING', 'DISPATCH', 'ZONES', 'KYC_AUDIT'],
  DISPATCH_OPERATOR: ['DISPATCH', 'DRIVERS', 'DRIVER_TELEMETRY', 'DRIVER_BATCHING', 'CANCELLATIONS', 'ANALYTICS', 'SMS_GATEWAY'],
  SUPPORT_AGENT: ['SUPPORT', 'CUSTOMERS', 'SMS_GATEWAY']
};

function hasRequiredRole(role, requiredRoles) {
  const grants = ADMIN_ROLE_GRANTS[role] || [role];
  return grants.some(granted => requiredRoles.includes(granted));
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}


function configuredAdminUsers() {
  try {
    // No built-in accounts: admins must come from VAAYU_ADMIN_USERS_JSON.
    const records = JSON.parse(process.env.VAAYU_ADMIN_USERS_JSON || '[]');
    if (!Array.isArray(records)) return [];
    return records.filter(record => record && typeof record.username === 'string' && typeof record.password === 'string' && ADMIN_PERMISSIONS[record.role]);
  } catch (_) {
    return [];
  }
}


// Brotli / Gzip Payload Compression Helper
function sendCompressedJsonResponse(req, res, statusCode, dataObj, extraHeaders = {}) {
  const acceptEncoding = (req.headers ? (req.headers['accept-encoding'] || '') : '').toLowerCase();
  let payload = typeof dataObj === 'string' ? Buffer.from(dataObj) : Buffer.from(JSON.stringify(dataObj));

  const headers = {
    'Content-Type': 'application/json',
    'Vary': 'Accept-Encoding',
    ...extraHeaders
  };

  if (payload.length > 1024) {
    if (acceptEncoding.includes('br')) {
      try {
        payload = zlib.brotliCompressSync(payload);
        headers['Content-Encoding'] = 'br';
      } catch (e) {}
    } else if (acceptEncoding.includes('gzip')) {
      try {
        payload = zlib.gzipSync(payload);
        headers['Content-Encoding'] = 'gzip';
      } catch (e) {}
    }
  }

  headers['Content-Length'] = payload.length;
  res.writeHead(statusCode, headers);
  res.end(payload);
}

function createTextPdf(lines) {
  const escapePdf = value => String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');
  const stream = [
    'BT',
    '/F1 12 Tf',
    '50 750 Td',
    ...lines.flatMap((line, index) => [index ? '0 -20 Td' : '', `(${escapePdf(line)}) Tj`]).filter(Boolean),
    'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, 'ascii'));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document, 'ascii');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) document += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(document, 'ascii');
}






// Parses a JSON request body. Returns the object, or null after answering 400 when the body is not a JSON object.
// Used by write routes so malformed input is refused, never silently treated as an empty body.
function parseJsonBody(res, body) {
  let data;
  try { data = JSON.parse(body || '{}'); } catch (_) { data = undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'INVALID_JSON', message: 'Request body must be a JSON object.' } }));
    return null;
  }
  return data;
}

// Field validation for write routes (PRODUCT_ISSUES.md T4). Each rule returns an error string or null.
// Returns the first failing message, or null when every rule passes. Responds 400 itself when invalid.
function validateFields(res, checks) {
  for (const [ok, message] of checks) {
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'INVALID_FIELD', message } }));
      return false;
    }
  }
  return true;
}
const isLatitude = v => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const isLongitude = v => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;


module.exports = {
  ADMIN_ROLE_GRANTS,
  ADMIN_PERMISSIONS,
  hasRequiredRole,
  csvCell,
  configuredAdminUsers,
  sendCompressedJsonResponse,
  createTextPdf,
  parseJsonBody,
  validateFields,
  isLatitude,
  isLongitude
};
