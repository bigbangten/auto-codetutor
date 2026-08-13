import { spawn } from 'node:child_process';
import './build.mjs';

const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
  stdio: 'inherit',
  shell: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
