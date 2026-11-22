import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
async function enumerate(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => entry.isDirectory() ? enumerate(path.join(dir, entry.name)) : entry.name.endsWith('.test.mjs') ? [path.join(dir, entry.name)] : []));
  return groups.flat().sort();
}
const requested = process.argv.slice(2);
const files = (await enumerate(path.join(root, 'test'))).filter((file) => !requested.length || requested.some((part) => file.includes(part)));
if (!files.length) throw new Error('No test files matched');
console.log(`Running ${files.length} test files`);
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: root, stdio: 'inherit' });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
