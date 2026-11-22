import { readFile } from 'node:fs/promises';
import { protocolError } from './schemas.mjs';
export async function loadReviewPreset(qualified = 'standard@2', mode = 'review') {
  if (!['quick@2', 'standard@2'].includes(qualified)) throw protocolError('PRESET_NOT_FOUND', qualified);
  const preset = JSON.parse(await readFile(new URL(`../../presets/${qualified}.json`, import.meta.url), 'utf8'));
  if (mode === 'review') {
    preset.stages = preset.stages.filter((stage) => !['build', 'verify'].includes(stage.id));
    preset.stages.at(-1).dependsOn = ['decide'];
  }
  const seen = new Set();
  for (const stage of preset.stages) {
    if (seen.has(stage.id) || stage.dependsOn.some((id) => !seen.has(id))) throw protocolError('INVALID_PRESET', qualified);
    seen.add(stage.id);
  }
  return preset;
}
