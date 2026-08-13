import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(dist, 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, 'src/main/preload.ts')],
    outfile: resolve(dist, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, 'src/renderer/renderer.ts')],
    outfile: resolve(dist, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome132',
    sourcemap: true,
    loader: { '.ttf': 'file' },
  }),
  build({
    entryPoints: [resolve(root, 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js')],
    outfile: resolve(dist, 'monaco-worker.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome132',
  }),
]);

await Promise.all([
  cp(resolve(root, 'src/renderer/index.html'), resolve(dist, 'index.html')),
  cp(resolve(root, 'src/renderer/styles.css'), resolve(dist, 'styles.css')),
]);

const wasmCandidates = [
  resolve(root, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'),
  resolve(root, 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm'),
];
await mkdir(resolve(root, 'assets'), { recursive: true });
for (const source of wasmCandidates) {
  try {
    await cp(source, resolve(root, 'assets/tree-sitter.wasm'));
    break;
  } catch { /* try the next package layout */ }
}
await cp(
  // VS Code ships the C++ grammar; tree-sitter-cpp is a strict superset for the
  // C translation units Auto CodeTutor indexes, and avoids a native addon.
  resolve(root, 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm'),
  resolve(root, 'assets/tree-sitter-c.wasm'),
);
await cp(
  resolve(root, 'node_modules/pdfjs-dist/standard_fonts'),
  resolve(root, 'assets/standard_fonts'),
  { recursive: true },
);
