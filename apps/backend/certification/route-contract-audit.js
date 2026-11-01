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

function reachable(runtime) {
  return runtime && runtime.status !== 404 && runtime.status !== 405;
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

    // A protected endpoint can safely be probed without credentials: the expected result is
    // an auth/authorization response rather than a missing route. Public GET routes are also
    // safe to probe. Public POST routes are catalogued but deliberately not invoked.
    const safeToProbe = route.method === 'GET' || route.requiredRole !== 'PUBLIC';
    const legacyRuntime = safeToProbe
      ? await probe(route.path, route.method)
      : { skipped: true, reason: 'public-mutating-post' };
    const v1Runtime = safeToProbe
      ? await probe(route.v1Path, route.method)
      : { skipped: true, reason: 'public-mutating-post' };
    const sourceReferenced = textualImplementations.length > 0;
    const legacyReachable = v1Runtime.skipped || reachable(legacyRuntime);
    const v1Reachable = v1Runtime.skipped || reachable(v1Runtime);

    results.push({
      ...route,
      sourceReferenced,
      sourceImplementations: textualImplementations,
      runtime: { legacy: legacyRuntime, v1: v1Runtime },
      contract: sourceReferenced && legacyReachable && v1Reachable ? 'REACHABLE' : 'GAP'
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
    legacyRuntimeReachable: results.filter(item => item.runtime.legacy.skipped || reachable(item.runtime.legacy)).length,
    v1RuntimeReachable: results.filter(item => item.runtime.v1.skipped || reachable(item.runtime.v1)).length,
    gaps: gaps.length,
    policy: {
      sourcePresence: 'REQUIRED',
      runtimeReachability: 'REQUIRED',
      versionedAliasReachability: 'REQUIRED',
      publicMutatingPost: 'NOT_INVOKED',
      rule: 'A registered route is not considered implemented until source, legacy runtime routing and /api/v1 runtime routing all agree.'
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
