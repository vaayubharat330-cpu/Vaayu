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

const portalSrcDir = path.join(__dirname, '..', 'portal-src');

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

  const match = sourceHtml.match(babelBlock);
  if (!match) {
    console.log(page, '-> no text/babel block, skipped');
    return;
  }
  const name = page.replace(/\.html$/, '');
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
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss');
  execFileSync(bin, ['-i', 'src/styles/tailwind.input.css', '-o', 'public/built/tailwind.css', '--minify'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log('styles -> built/tailwind.css');
}

(async () => {
  for (const page of pages) await buildPage(page);
  buildStyles();
})().catch((e) => {
  console.error('BUILD ERROR', e.message);
  process.exit(1);
});
