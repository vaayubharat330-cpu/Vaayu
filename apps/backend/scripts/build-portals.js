// Precompiles the JSX inside each portal page into a static script, so the pages
// no longer need the in-browser Babel transformer (which requires 'unsafe-eval').
// Each page's <script type="text/babel"> block is replaced by a reference to
// public/built/<page>.js. Run with: node scripts/build-portals.js
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const publicDir = path.join(__dirname, '..', 'public');
const outDir = path.join(publicDir, 'built');
const pages = ['index.html', 'merchant.html', 'fleet.html', 'admin.html', 'public-track.html'];

const babelBlock = /<script\b[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/i;
const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const portalSrcDir = path.join(__dirname, '..', 'portal-src');
let generatedPortalCss = '';

function hasLocalStylesheet(html, href) {
  return html.includes(`href="${href}"`) || html.includes(`href='${href}'`);
}

function injectBeforeHeadClose(html, markup) {
  const headClose = html.match(/<\/head\s*>/i);
  if (!headClose || headClose.index === undefined) {
    throw new Error('Portal HTML is missing a closing </head> element.');
  }
  return `${html.slice(0, headClose.index)}${markup}${html.slice(headClose.index)}`;
}

function normalizePortalAssets(html) {
  let normalized = html;

  normalized = normalized.replace(/\s*<!--\s*Tailwind CSS CDN\s*-->\s*/gi, '\n');
  normalized = normalized.replace(/<script\b[^>]+src=["']https:\/\/cdn\.tailwindcss\.com["'][^>]*><\/script>/gi, '');

  if (!hasLocalStylesheet(normalized, '/built/tailwind.css')) {
    normalized = injectBeforeHeadClose(
      normalized,
      '  <link rel="stylesheet" href="/built/tailwind.css">\n'
    );
  }

  // portal.css is already an explicitly allowlisted static asset in the HTTP
  // server. Keep all shared/page CSS on that one asset so generated portals do
  // not create unserved per-page stylesheet files.
  normalized = normalized.replace(styleBlock, (_, css) => {
    const trimmed = css.trim();
    if (trimmed) generatedPortalCss += `\n${trimmed}\n`;
    return '';
  });
  if (!hasLocalStylesheet(normalized, '/built/portal.css')) {
    normalized = injectBeforeHeadClose(
      normalized,
      '  <link rel="stylesheet" href="/built/portal.css">\n'
    );
  }

  return normalized;
}

function assertGeneratedPortalHtml(html, page, name) {
  const lower = html.toLowerCase();
  const checks = [
    [html.includes('/built/tailwind.css'), 'missing /built/tailwind.css'],
    [html.includes('/built/portal.css'), 'missing /built/portal.css'],
    [html.includes(`/built/${name}.js`), `missing /built/${name}.js`],
    [!lower.includes('cdn.tailwindcss.com'), 'Tailwind CDN reference remains'],
    [!lower.includes('type="text/babel"'), 'uncompiled text/babel script remains'],
    [!lower.includes('<style'), 'inline style block remains'],
  ];

  for (const [ok, message] of checks) {
    if (!ok) {
      throw new Error(`${page}: generated portal contract failed: ${message}`);
    }
  }
}

async function buildPage(page) {
  const portalSrcPath = path.join(portalSrcDir, page);
  const publicHtmlPath = path.join(publicDir, page);

  let sourceHtml;
  if (fs.existsSync(portalSrcPath)) {
    sourceHtml = fs.readFileSync(portalSrcPath, 'utf8');
  } else if (fs.existsSync(publicHtmlPath)) {
    sourceHtml = fs.readFileSync(publicHtmlPath, 'utf8');
  } else {
    throw new Error(`${page}: portal source file was not found`);
  }

  const name = page.replace(/\.html$/, '');
  sourceHtml = normalizePortalAssets(sourceHtml);

  const match = sourceHtml.match(babelBlock);
  if (!match) {
    throw new Error(`${page}: expected a text/babel application block, but none was found`);
  }

  const result = await esbuild.transform(match[1], {
    loader: 'jsx',
    jsx: 'transform',
    target: 'es2019',
    minify: true,
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.js`), result.code, 'utf8');

  const replaced = sourceHtml.replace(
    babelBlock,
    `<script src="/built/${name}.js" defer></script>`
  );

  assertGeneratedPortalHtml(replaced, page, name);
  fs.writeFileSync(publicHtmlPath, replaced, 'utf8');
  console.log(page, '-> built/' + name + '.js', result.code.length, 'bytes');
}

function buildStyles() {
  const { execFileSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'tailwindcss');
  const tailwindCli = path.join(__dirname, '..', 'node_modules', 'tailwindcss', 'lib', 'cli.js');
  const cliArgs = ['-i', 'src/styles/tailwind.input.css', '-o', 'public/built/tailwind.css', '--minify'];

  if (fs.existsSync(bin)) {
    execFileSync(bin, cliArgs, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } else if (fs.existsSync(tailwindCli)) {
    execFileSync(process.execPath, [tailwindCli, ...cliArgs], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } else {
    throw new Error('Tailwind CSS CLI is not installed; run npm ci with devDependencies enabled');
  }

  console.log('styles -> built/tailwind.css');
}

function writePortalCss() {
  const portalCssPath = path.join(outDir, 'portal.css');
  const existing = fs.existsSync(portalCssPath) ? fs.readFileSync(portalCssPath, 'utf8') : '';
  const marker = '/* VAAYU GENERATED PORTAL CSS */';
  const markerIndex = existing.indexOf(marker);
  const stableBase = markerIndex >= 0 ? existing.slice(0, markerIndex).trimEnd() : existing.trimEnd();
  const generated = generatedPortalCss.trim();
  const content = generated
    ? `${stableBase}${stableBase ? '\n\n' : ''}${marker}\n${generated}\n`
    : `${stableBase}\n`;
  fs.writeFileSync(portalCssPath, content, 'utf8');
  console.log('styles -> built/portal.css');
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  for (const page of pages) {
    await buildPage(page);
  }
  buildStyles();
  writePortalCss();
})().catch((error) => {
  console.error('BUILD ERROR', error.stack || error.message);
  process.exit(1);
});
