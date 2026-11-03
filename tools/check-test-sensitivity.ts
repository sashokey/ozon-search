import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { build } from 'esbuild';
import { minify } from 'terser';

const root = new URL('../', import.meta.url);
const selected = 'reads rating and review metrics independently|combines Fresh delivery with the selected';
const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
await mkdir(new URL('.build/', root), { recursive: true });
const temporary = await mkdtemp(fileURLToPath(new URL('.build/test-sensitivity-', root)));

async function run(name: string, input: string, expectedFailure?: string): Promise<void> {
  const metadata = input.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0];
  assert.ok(metadata, 'Missing userscript metadata');
  const sourcePath = `${temporary}/ozon-search.src.ts`;
  await writeFile(sourcePath, input);
  const checked = spawnSync(process.execPath, [compiler, '--noEmit', '--project', `${temporary}/tsconfig.json`], {
    cwd: temporary, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const compiled = await build({ entryPoints: [sourcePath], bundle: true, write: false, format: 'iife', target: 'es2022', legalComments: 'none', treeShaking: true });
  const code = compiled.outputFiles[0]?.text;
  assert.ok(code, 'Compilation produced no executable code');
  const readable = await minify(code, { compress: false, mangle: false, format: { beautify: true, comments: false } });
  const minified = await minify(code, { compress: { passes: 10 }, mangle: true, format: { comments: false } });
  assert.ok(readable.code, 'Compilation produced no readable code');
  assert.ok(minified.code, 'Minification produced no executable code');
  new Script(readable.code);
  new Script(minified.code);
  await writeFile(`${temporary}/.build/ozon-search.js`, metadata + '\n' + readable.code + '\n');
  await writeFile(`${temporary}/ozon-search.user.js`, metadata + '\n' + minified.code + '\n');
  const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${selected}`, `${temporary}/tests/behavior.test.ts`], {
    cwd: temporary, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024
  });
  const output = tests.stdout + tests.stderr;
  if (!expectedFailure) {
    assert.equal(tests.status, 0, output);
  } else {
    assert.equal(tests.status, 1, output);
    const failed = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
    for (const artifact of ['compiled', 'user']) assert.ok(failed.includes(`${artifact}: ${expectedFailure}`), output);
  }
  process.stdout.write(`${name}: ${expectedFailure ? 'rejected by both artifacts' : 'passed'}\n`);
}

try {
  const source = await readFile(new URL('ozon-search.src.ts', root), 'utf8');
  await cp(new URL('tests/', root), `${temporary}/tests`, { recursive: true });
  await cp(new URL('tsconfig.json', root), `${temporary}/tsconfig.json`);
  await cp(new URL('package.json', root), `${temporary}/package.json`);
  await mkdir(`${temporary}/.build`);
  await run('Observed-scenario baseline', source);
  for (const [name, predicate, expectedFailure] of [
    ['Disabled rating filter', 'rated && !(rating >= lo && rating <= hi)', 'reads rating and review metrics independently of product brand labels'],
    ['Disabled Fresh delivery filter', 'delivery && !fast', 'combines Fresh delivery with the selected rating and review ranges']
  ] as const) {
    assert.equal(source.split(predicate).length, 2);
    await run(name, source.replace(predicate, 'false'), expectedFailure);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
