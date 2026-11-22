import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const vm = (await readFile(new URL('src/review/view-model.mjs', root), 'utf8')).replace(/^export /gm, '');
const panel = (await readFile(new URL('client/review-panel.mjs', root), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const original = await readFile(new URL('client.js', root), 'utf8');
const generated = `/* REVIEW_CLIENT_BEGIN */\n    const reviewClient = (() => {\n${vm}\n${panel}\nreturn { reviewMessages, createReviewPanel, reviewViewModel, createReviewRequestGate, decodeReviewResponse };\n})();\n    const ReviewClientPanel = reviewClient.createReviewPanel(React, h);\n    /* REVIEW_CLIENT_END */`;
const updated = original.replace(/\/\* REVIEW_CLIENT_BEGIN \*\/[\s\S]*?\/\* REVIEW_CLIENT_END \*\//, generated);
if (updated === original && !original.includes(generated)) throw new Error('Client build markers were not found');
if (process.argv.includes('--check')) { if (updated !== original) throw new Error('Client artifact is stale; run npm run build:client'); }
else if (updated !== original) await writeFile(new URL('client.js', root), updated, 'utf8');
const { reviewMessages } = await import('../client/review-panel.mjs');
for (const lang of ['zh', 'en']) {
  const target = new URL(`locale/${lang}.json`, root); const source = await readFile(target, 'utf8');
  const next = `${JSON.stringify({ ...JSON.parse(source), ...reviewMessages[lang] }, null, 2)}\n`;
  if (process.argv.includes('--check')) { if (next !== source) throw new Error(`Review ${lang} dictionary is stale`); }
  else if (source !== next) await writeFile(target, next, 'utf8');
}
console.log(`Review client ${process.argv.includes('--check') ? 'verified' : 'built'}: ${fileURLToPath(new URL('client.js', root))}`);
