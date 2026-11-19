import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';

import { appendRun, pruneRuns, writeDeals } from '../../src/core/store.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cazador-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('appendRun escribe JSONL por corrida con timestamp seguro para Windows', () => {
  const products = [
    { productId: '1', price: 1000 },
    { productId: '2', price: 2000 },
  ];

  const file = appendRun(dir, 'PedidosYa', products);

  assert.equal(file.startsWith(join(dir, 'runs')), true);
  assert.equal(existsSync(file), true);
  assert.match(basename(file), /^PedidosYa-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/);
  assert.equal(basename(file).includes(':'), false);

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), products[0]);
  assert.deepEqual(JSON.parse(lines[1]), products[1]);
});

test('appendRun sanea el nombre de plataforma', () => {
  const file = appendRun(dir, 'Uber Eats', []);
  assert.match(basename(file), /^Uber-Eats-/);
  assert.equal(existsSync(file), true);
});

test('writeDeals escribe deals.json y no deja temporales', () => {
  const deals = { generatedAt: '2026-11-18T12:00:00.000Z', deals: [{ productId: '1' }] };
  const file = writeDeals(dir, deals);

  assert.equal(file, join(dir, 'deals.json'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), deals);
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), []);
});

test('writeDeals sobrescribe de forma atómica', () => {
  writeDeals(dir, { version: 1 });
  writeDeals(dir, { version: 2 });

  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'deals.json'), 'utf8')), { version: 2 });
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), []);
});

test('pruneRuns borra sólo corridas viejas de runs/', () => {
  const runs = join(dir, 'runs');
  mkdirSync(runs);

  const oldFile = join(runs, 'PedidosYa-2020-01-01T00-00-00-000Z.jsonl');
  const futureFile = join(runs, 'Rappi-2099-01-01T00-00-00-000Z.jsonl');
  const malformed = join(runs, 'sin-fecha.jsonl');
  const notes = join(runs, 'notes.txt');

  writeFileSync(oldFile, '{}\n');
  writeFileSync(futureFile, '{}\n');
  writeFileSync(malformed, '{}\n');
  writeFileSync(notes, 'no tocar\n');
  utimesSync(malformed, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

  const deleted = pruneRuns(dir, 7);

  assert.deepEqual(deleted, [oldFile, malformed].sort());
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(malformed), false);
  assert.equal(existsSync(futureFile), true);
  assert.equal(existsSync(notes), true);
});

test('pruneRuns no falla si todavía no hay corridas', () => {
  assert.deepEqual(pruneRuns(dir, 7), []);
});

test('writeDeals limpia el .tmp si el rename falla', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deals-fail-'));
  try {
    mkdirSync(join(dir, 'deals.json'));
    assert.throws(() => writeDeals(dir, { a: 1 }));
    const leftovers = readdirSync(dir).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
