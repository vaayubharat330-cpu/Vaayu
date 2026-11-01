'use strict';

// Runtime contract audit for the enterprise route registry.
// This is intentionally read-only: protected routes are probed without credentials so
// authentication/authorization gates are exercised, while public POST commands are not
// invoked because they may create external state. Both legacy and /api/v1 aliases are
// checked because the registry promises versioned routing as part of its contract.
const fs = require('fs');
const path = require('path');
const { routeRegistryService } = require('../src/services/routeRegistryService');

const base = String(process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000').replace(/\/$/, '');
const evidenceDir = path.resolve(__dirname, 'artifacts');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Route contract audit requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function probe(pathname, method) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${pathname}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    return { status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { status: null, latencyMs: Date.now() - started, error: error.message };
  }
}

function expectedOutcome(route) {
  if (route.requiredRole === 'PUBLIC') {
    // Public GETs are safe to execute and must produce a real successful response.
    // Public POSTs are intentionally skipped because they may mutate external state.
    return route.method === 'GET'
      ? { type: 'PUBLIC_GET', allowedStatuses: [200, 204, 301, 302, 304] }
      : { type: 'PUBLIC_MUTATING_POST', skipped: true };
  }

  // Protected probes intentionally carry no credentials. A healthy protected endpoint
  // must reject the request through its auth/RBAC boundary, not merely return some
  // non-404 response. This prevents 500/502/503 responses from being misclassified as
  // reachable/healthy routes.
  return { type: 'PROTECTED_UNAUTHENTICATED', allowedStatuses: [401, 403] };
}

function evaluateProbe(runtime, expected) {
  if (expected.skipped) return { passed: true, reason: 'public-mutating-post' };
  if (!runtime || runtime.status == null) {
    return { passed: false, reason: runtime?.error || 'NO_RESPONSE' };
  }
  const passed = expected.allowedStatuses.includes(runtime.status);
  return {
    passed,
    reason: passed ? 'EXPECTED_STATUS' : `UNEXPECTED_STATUS_${runtime.status}`,
    allowedStatuses: expected.allowedStatuses,
  };
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const srcRoot = path.resolve(__dirname, '..', 'src');
  const files = walk(srcRoot).filter(file => !file.endsWith(`${path.sep}routeRegistryService.js`));
  const source = files.map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const routes = routeRegistryService.getRegisteredRoutes();

  const results = [];
  for (const route of routes) {
    const textualImplementations = source
      .filter(item => item.text.includes(`'${route.path}'`) || item.text.includes(`"${route.path}"`))
      .map(item => path.relative(srcRoot, item.file));

    const expected = expectedOutcome(route);
    const legacyRuntime = expected.skipped
      ? { skipped: true, reason: 'public-mutating-post' }
      : await probe(route.path, route.method);
    const v1Runtime = expected.skipped
      ? { skipped: true, reason: 'public-mutating-post' }
      : await probe(route.v1Path, route.method);
    const sourceReferenced = textualImplementations.length > 0;
    const legacyEvaluation = evaluateProbe(legacyRuntime, expected);
    const v1Evaluation = evaluateProbe(v1Runtime, expected);

    results.push({
      ...route,
      sourceReferenced,
      sourceImplementations: textualImplementations,
      expectedOutcome: expected,
      runtime: { legacy: legacyRuntime, v1: v1Runtime },
      evaluation: { legacy: legacyEvaluation, v1: v1Evaluation },
      contract: sourceReferenced && legacyEvaluation.passed && v1Evaluation.passed ? 'REACHABLE' : 'GAP'
    });
  }

  const gaps = results.filter(item => item.contract === 'GAP');
  const summary = {
    generatedAt: new Date().toISOString(),
    target,
    baseUrl: base,
    totalRegisteredRoutes: results.length,
    sourceReferenced: results.filter(item => item.sourceReferenced).length,
    runtimeProbed: results.filter(item => !item.runtime.legacy.skipped).length,
    semanticallyHealthy: results.filter(item => item.contract === 'REACHABLE').length,
    gaps: gaps.length,
    policy: {
      sourcePresence: 'REQUIRED',
      semanticRuntimeContract: 'REQUIRED',
      versionedAliasSemanticContract: 'REQUIRED',
      publicMutatingPost: 'NOT_INVOKED',
      protectedUnauthenticatedStatuses: [401, 403],
      publicGetSuccessStatuses: [200, 204, 301, 302, 304],
      rule: 'A registered route is not considered implemented until source, legacy runtime semantics and /api/v1 runtime semantics all agree.'
    }
  };

  const evidence = { summary, routes: results };
  fs.writeFileSync(path.join(evidenceDir, 'route-contract-audit.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (gaps.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
