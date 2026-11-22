import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const item of ['host/index.js', 'host/review-service.mjs', 'host/review-plugin.mjs', 'host/dsh/agent-runner.mjs', 'host/dsh/file-store.mjs', 'host/dsh/tools.mjs', 'host/dsh/review-route.mjs', 'host/dsh/commands.mjs', 'host/dsh/history.mjs', 'src/review/view-model.mjs', 'src/review/usage.mjs', 'client.js', 'host/develop-controller.mjs', 'host/dsh/project-files.mjs', 'src/review/checks.mjs', 'src/review/rework.mjs', 'src/review/revisions.mjs', 'src/review/schemas.mjs', 'src/review/types.d.ts', 'src/review/runner.mjs', 'presets/quick@2.json', 'presets/standard@2.json', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
  await access(new URL(`../${item}`, import.meta.url));
  if (!manifest.files.some((rule) => item === rule || (rule.endsWith('/**') && item.startsWith(rule.slice(0, -2))) || (rule.endsWith('/*.json') && item.startsWith(rule.slice(0, -6)) && item.endsWith('.json')))) throw new Error(`Package omits ${item}`);
}
const checkClient = spawnSync(process.execPath, ['tools/build-client.mjs', '--check'], { cwd: root, stdio: 'inherit' });
if (checkClient.error) throw checkClient.error;
if (checkClient.status !== 0) throw new Error('Client artifact or locale resources are stale');
const args = ['pack', '--dry-run', '--ignore-scripts'];
const npmCli = process.env.npm_execpath;
const packed = npmCli ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' }) : spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd pack --dry-run --ignore-scripts'] : args, { cwd: root, stdio: 'inherit' });
if (packed.error) throw packed.error;
if (packed.status !== 0) process.exitCode = packed.status ?? 1;
else console.log('Review runtime, presets and display resources are included.');
