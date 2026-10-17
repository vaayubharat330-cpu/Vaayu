'use strict';

/**
 * VAAYU portal CSP compatibility.
 *
 * The portal UIs are React applications and legitimately use element-level
 * style attributes for dynamic map/visual state. CSP Level 3 lets us allow
 * those attributes separately from stylesheet elements, so we do not have
 * to weaken `style-src` with `unsafe-inline`.
 *
 * This wrapper is applied before server_production.js loads Helmet. It only
 * adds the narrowly-scoped style-src-attr directive; all other Helmet policy
 * directives remain owned by server_production.js.
 */
function installHelmetCspCompat() {
  const moduleId = require.resolve('helmet');
  const helmet = require(moduleId);

  if (helmet.__vaayuCspCompatInstalled) return;

  const wrappedHelmet = function vaayuHelmetCompat(options = {}, ...args) {
    const existingCsp = options.contentSecurityPolicy;
    if (existingCsp && existingCsp !== false) {
      const directives = { ...(existingCsp.directives || {}) };
      if (!directives['style-src-attr']) {
        directives['style-src-attr'] = ["'unsafe-inline'"];
      }
      options = {
        ...options,
        contentSecurityPolicy: {
          ...existingCsp,
          directives
        }
      };
    }
    return helmet(options, ...args);
  };

  Object.assign(wrappedHelmet, helmet, { __vaayuCspCompatInstalled: true });
  require.cache[moduleId].exports = wrappedHelmet;
}

module.exports = { installHelmetCspCompat };
