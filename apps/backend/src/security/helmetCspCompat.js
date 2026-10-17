'use strict';

/**
 * VAAYU portal CSP compatibility.
 *
 * The portal UIs are React applications and legitimately use element-level
 * style attributes for dynamic map/visual state. CSP Level 3 lets us allow
 * those attributes separately from stylesheet elements, so we do not have
 * to weaken `style-src` with `unsafe-inline`.
 *
 * The compatibility layer is intentionally defensive: it adds the directive
 * to Helmet's options and also normalizes the final response header. This
 * keeps the behavior correct even when the installed Helmet version does not
 * serialize newer CSP directives itself.
 */
function withStyleSrcAttrDirective(headerValue) {
  if (typeof headerValue !== 'string') return headerValue;
  if (/(?:^|;)\s*style-src-attr\s+/i.test(headerValue)) return headerValue;
  return `${headerValue}; style-src-attr 'unsafe-inline'`;
}

function installHelmetCspCompat() {
  const moduleId = require.resolve('helmet');
  const helmet = require(moduleId);

  if (helmet.__vaayuCspCompatInstalled) return;

  const wrappedHelmet = function vaayuHelmetCompat(options = {}, ...args) {
    const existingCsp = options.contentSecurityPolicy;
    let nextOptions = options;

    if (existingCsp && existingCsp !== false) {
      const directives = { ...(existingCsp.directives || {}) };
      if (!directives['style-src-attr']) {
        directives['style-src-attr'] = ["'unsafe-inline'"];
      }
      nextOptions = {
        ...options,
        contentSecurityPolicy: {
          ...existingCsp,
          directives
        }
      };
    }

    const middleware = helmet(nextOptions, ...args);
    return function vaayuHelmetCompatMiddleware(req, res, next) {
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        if (String(name).toLowerCase() === 'content-security-policy') {
          if (Array.isArray(value)) {
            value = value.map(withStyleSrcAttrDirective);
          } else {
            value = withStyleSrcAttrDirective(value);
          }
        }
        return originalSetHeader(name, value);
      };

      try {
        return middleware(req, res, (error) => {
          res.setHeader = originalSetHeader;
          next(error);
        });
      } catch (error) {
        res.setHeader = originalSetHeader;
        throw error;
      }
    };
  };

  Object.assign(wrappedHelmet, helmet, { __vaayuCspCompatInstalled: true });
  require.cache[moduleId].exports = wrappedHelmet;
}

module.exports = { installHelmetCspCompat };
