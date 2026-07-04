const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testMode = process.argv.includes('--test');

const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`[ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

async function buildExtension() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'out/extension.js',
    external: ['vscode'],
    logLevel: 'warning',
    plugins: [problemMatcherPlugin],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

function findTestEntryPoints(dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) {
      entries.push(...findTestEntryPoints(full));
    } else if (name.name.endsWith('.test.ts')) {
      entries.push(full);
    }
  }
  return entries;
}

async function buildTests() {
  const testDir = path.join('src', 'test', 'data');
  if (!fs.existsSync(testDir)) {
    console.log('[test] no data-layer test directory found, skipping');
    return;
  }
  const entryPoints = findTestEntryPoints(testDir);
  if (entryPoints.length === 0) {
    console.log('[test] no *.test.ts files found, skipping');
    return;
  }
  await esbuild.build({
    entryPoints,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outdir: 'out/test/data',
    sourcemap: true,
    logLevel: 'warning',
  });
  console.log(`[test] bundled ${entryPoints.length} test file(s) to out/test/data`);
}

async function main() {
  if (testMode) {
    await buildTests();
    return;
  }
  await buildExtension();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
