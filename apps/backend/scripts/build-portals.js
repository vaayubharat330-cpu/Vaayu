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

const babelBlock = /<script type="text\/babel"([^>]*)>([\s\S]*?)<\/script>/;
const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

const portalSrcDir = path.join(__dirname, '..', 'portal-src');

function hasLocalStylesheet(html, name) {
  return html.includes(`href="${name}"`) || html.includes(`href='${name}'`);
}

function normalizePortalAssets(html, name) {
  let normalized = html;

  // The source pages historically referenced the Tailwind CDN. Generated
  // production-facing portals must be deterministic and CSP-compatible, so
  // always use the repository's compiled stylesheet instead.
  normalized = normalized.replace(/\s*<!--\s*Tailwind CSS CDN\s*-->\s*/gi, '\n');
  normalized = normalized.replace(/<script[^>]+src=["']https:\/\/cdn\.tailwindcss\.com["'][^>]*><\/script>/gi, '');
  if (!hasLocalStylesheet(normalized, '/built/tailwind.css')) {
    normalized = normalized.replace('</head>', '  <link rel="stylesheet" href="/built/tailwind.css">\n</head>');
  }

  // Shared non-Tailwind layout rules are also local so portal rendering does
  // not depend on inline stylesheet blocks or a remote runtime stylesheet.
  if (!hasLocalStylesheet(normalized, '/portal-shell.css')) {
    normalized = normalized.replace('</head>', '  <link rel="stylesheet" href="/portal-shell.css">\n</head>');
  }

  // Extract page-specific <style> blocks into static CSS files. This keeps
  // style-src strict while preserving the existing visual design.
  let inlineCss = '';
  normalized = normalized.replace(styleBlock, (_, css) => {
    inlineCss += `\n${css.trim()}\n`;
    return '';
  });
  if (inlineCss.trim()) {
    const cssPath = path.join(outDir, `${name}.inline.css`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(cssPath, `${inlineCss.trim()}\n`, 'utf8');
    normalized = normalized.replace('</head>', `  <link rel="stylesheet" href="/built/${name}.inline.css">\n</head>`);
  }

  return normalized;
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
    console.log(page, '-> file not found, skipped');
    return;
  }

  const name = page.replace(/\.html$/, '');
  sourceHtml = normalizePortalAssets(sourceHtml, name);

  const match = sourceHtml.match(babelBlock);
  if (!match) {
    console.log(page, '-> no text/babel block, skipped');
    return;
  }
  const result = await esbuild.transform(match[2], {
    loader: 'jsx',
    jsx: 'transform',
    target: 'es2019',
    minify: true,
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.js`), result.code, 'utf8');
  const replaced = sourceHtml.replace(babelBlock, `<script src="/built/${name}.js" defer></script>`);
  fs.writeFileSync(publicHtmlPath, replaced, 'utf8');
  console.log(page, '-> built/' + name + '.js', result.code.length, 'bytes');
}

function buildStyles() {
  const { execFileSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'tailwindcss');
  const tailwindCli = path.join(__dirname, '..', 'node_modules', 'tailwindcss', 'lib', 'cli.js');
  const cliArgs = ['-i', 'src/styles/tailwind.input.css', '-o', 'public/built/tailwind.css', '--minify'];

  // npm normally creates node_modules/.bin/tailwindcss. Some CI/npm layouts can
  // install the package correctly while omitting that convenience shim. Resolve
  // directly to the pinned Tailwind v3 CLI in that case so portal builds remain
  // deterministic and do not reach out to an unpinned npx package.
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

(async () => {
  for (const page of pages) await buildPage(page);
  buildStyles();
})().catch((e) => {
  console.error('BUILD ERROR', e.message);
  process.exit(1);
});
