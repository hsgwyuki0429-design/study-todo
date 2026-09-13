import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('初回のオフライン起動に必要なES Moduleがすべてシェルに含まれる', async () => {
  const root = new URL('../', import.meta.url);
  const worker = await readFile(new URL('sw.js', root), 'utf8');
  const shell = worker.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const entries = [...shell.matchAll(/'([^']+)'/g)].map((match) => new URL(match[1], root).href);
  const cached = new Set(entries);
  for (const entry of entries.filter((url) => url.endsWith('.js'))) {
    const source = await readFile(new URL(entry), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      const dependency = new URL(match[1], entry).href;
      assert.ok(cached.has(dependency), `${entry} imports an uncached module: ${match[1]}`);
    }
  }
});
