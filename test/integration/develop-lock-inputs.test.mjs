import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DshProjectFiles } from '../../host/dsh/project-files.mjs';
import { testStore } from './helpers.mjs';
for (const lock of ['yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json']) test(`${lock} remains part of a restricted check input snapshot`, async (t) => {
  const disk = await testStore(); t.after(disk.cleanup);
  disk.fs.readBytes = async (target) => readFile(target.targetKey);
  await disk.fs.writeText(await disk.fs.resolve('src/value.mjs'), 'export const value = 1;');
  await disk.fs.writeText(await disk.fs.resolve(lock), 'first lock content');
  const files = new DshProjectFiles(disk.fs, disk.projectRoot);
  const before = await files.snapshot({ inputs: ['src/**'] });
  assert.ok(before.files[lock], 'lock must be included even outside explicit source inputs');
  await disk.fs.writeText(await disk.fs.resolve(lock), 'second lock content');
  const after = await files.snapshot({ inputs: ['src/**'] });
  assert.notEqual(before.digest, after.digest);
});
