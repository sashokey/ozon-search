import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { minify } from 'terser';

const name = 'ozon-search';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL(name + '.src.ts', root), 'utf8');
const metadata = source.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0];
if (!metadata) throw new Error('Missing userscript metadata');
const compiled = await build({ entryPoints: [fileURLToPath(new URL(name + '.src.ts', root))], bundle: true, write: false, format: 'iife', target: 'es2022', legalComments: 'none', treeShaking: true });
const code = compiled.outputFiles[0]?.text;
if (!code) throw new Error('Compilation produced no executable code');
new Script(code);
const result = await minify(code, { compress: { passes: 10 }, mangle: true, format: { comments: false } });
if (!result.code) throw new Error('Minification produced no executable code');
const output = metadata + '\n' + result.code + '\n';
new Script(output);
await mkdir(new URL('.build/', root), { recursive: true });
const readable = await minify(code, { compress: false, mangle: false, format: { beautify: true, comments: false } });
if (!readable.code) throw new Error('Compilation produced no readable code');
new Script(readable.code);
await writeFile(new URL('.build/' + name + '.js', root), metadata + '\n' + readable.code + '\n');
const target = new URL(name + '.user.js', root);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Regenerate the shipped userscript with npm run build');
} else await writeFile(target, output);
