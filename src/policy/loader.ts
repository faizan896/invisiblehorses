import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { PolicySchema } from './schema.js';
export function loadPolicy(path: string) {
  const doc = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Invalid policy YAML');
  return PolicySchema.parse(doc.toJS({ maxAliasCount: 0 }));
}
