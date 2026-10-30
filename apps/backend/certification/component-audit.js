'use strict';

/**
 * VAAYU Certification Component Audit
 *
 * This is intentionally conservative: a component is never marked FUNCTIONAL
 * merely because its source file parses. The audit proves infrastructure,
 * discovers backend source components, syntax-checks them, and reports which
 * areas still require behavioural certification suites.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const srcRoot = path.resolve(root, 'src');
const evidenceDir = path.resolve(__dirname, 'artifacts');
const baseUrl = String(process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000').replace(/\/$/, '');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Component audit requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

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

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    error: String(result.stderr || result.stdout || '').trim().slice(-4000),
  };
}

async function httpCheck(pathname) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(5000) });
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error.message };
  }
}

function classify(relative) {
  const parts = relative.split(path.sep);
  const area = parts.length > 1 ? parts[0] : 'root';
  const name = path.basename(relative);
  return { area, name, path: relative };
}

async function main() {
  const files = walk(srcRoot);
  const components = files.map(file => {
    const relative = path.relative(srcRoot, file);
    const syntax = syntaxCheck(file);
    return { ...classify(relative), syntax };
  });

  const areas = [...new Set(components.map(x => x.area))].sort();
  const infrastructure = {
    health: await httpCheck('/health'),
    apiHealth: await httpCheck('/api/health'),
  };

  const syntaxFailures = components.filter(x => !x.syntax.ok);
  const result = {
    generatedAt: new Date().toISOString(),
    target,
    baseUrl,
    summary: {
      sourceFiles: components.length,
      areas: areas.length,
      syntaxPassed: components.length - syntaxFailures.length,
      syntaxFailed: syntaxFailures.length,
      infrastructurePassed: Object.values(infrastructure).filter(x => x.ok).length,
      infrastructureChecks: Object.keys(infrastructure).length,
    },
    areas,
    components,
    infrastructure,
    certificationPolicy: {
      syntaxCheck: 'PROVEN',
      infrastructureReachability: 'PROVEN',
      behaviouralFunctionality: 'MUST_BE_PROVEN_BY_BEHAVIOURAL_SUITES',
      rule: 'Never infer component functionality from source presence or syntax success.',
    },
  };

  fs.writeFileSync(path.join(evidenceDir, 'component-audit.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  if (syntaxFailures.length || !infrastructure.health.ok || !infrastructure.apiHealth.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
