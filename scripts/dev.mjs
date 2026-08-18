import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import './build.mjs';

const require = createRequire(import.meta.url);
const electron = require('electron');
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  shell: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
