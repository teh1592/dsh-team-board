import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const vm = (await readFile(new URL('src/review/view-model.mjs', root), 'utf8')).replace(/^export /gm, '');
const parts = await Promise.all(['client/request-state.mjs', 'client/styles.mjs', 'client/messages.mjs', 'client/review-panel.mjs'].map(async (path) => (await readFile(new URL(path, root), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')));
const panel = parts.join('\n');
const original = await readFile(new URL('client.js', root), 'utf8');
const generated = `/* REVIEW_CLIENT_BEGIN */\n    const reviewClient = (() => {\n${vm}\n${panel}\nreturn { reviewMessages, createReviewPanel, reviewViewModel, reviewRow, reviewControls, discussionView, roleLedgerMessageKey, boardTabs, createReviewRequestGate, decodeReviewResponse, createBoardRequestState, createReferenceStack, continueBoardReads };\n})();\n    /* REVIEW_CLIENT_END */`;
const updated = original.replace(/\/\* REVIEW_CLIENT_BEGIN \*\/[\s\S]*?\/\* REVIEW_CLIENT_END \*\//, generated);
if (updated === original && !original.includes(generated)) throw new Error('Client build markers were not found');
if (process.argv.includes('--check')) { if (updated !== original) throw new Error('Client artifact is stale; run npm run build:client'); }
else if (updated !== original) await writeFile(new URL('client.js', root), updated, 'utf8');
const { reviewMessages } = await import('../client/review-panel.mjs');
for (const lang of ['zh', 'en']) {
  const target = new URL(`locale/${lang}.json`, root); const source = await readFile(target, 'utf8');
  const existing = Object.fromEntries(Object.entries(JSON.parse(source)).filter(([key]) => !key.startsWith('review.') && !key.startsWith('boardUi.')));
  const next = `${JSON.stringify({ ...existing, ...reviewMessages[lang] }, null, 2)}\n`;
  if (process.argv.includes('--check')) { if (next !== source) throw new Error(`Review ${lang} dictionary is stale`); }
  else if (source !== next) await writeFile(target, next, 'utf8');
}
console.log(`Review client ${process.argv.includes('--check') ? 'verified' : 'built'}: ${fileURLToPath(new URL('client.js', root))}`);
