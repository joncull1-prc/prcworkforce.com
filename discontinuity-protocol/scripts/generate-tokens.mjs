#!/usr/bin/env node
/**
 * Generate a batch of printed activation codes.
 *
 * Produces two files with deliberately different destinations:
 *   tokens-<batch>-print.csv   the clear codes. Goes to the printer, never to
 *                              the database, never to git. Destroy after the run.
 *   tokens-<batch>-load.sql    keyed hashes only. This is what the database gets.
 *
 * The pepper must be the same value as the Worker's TOKEN_PEPPER secret. If the
 * two ever differ, every printed ledger in that batch is dead on arrival, so the
 * script refuses to run without it rather than inventing one.
 *
 * Usage:
 *   TOKEN_PEPPER=$(openssl rand -hex 32) node scripts/generate-tokens.mjs 500 batch-2026-10
 */

import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O or U.
const CODE_LENGTH = 10;

const count = Number.parseInt(process.argv[2] ?? '', 10);
const batchRef = process.argv[3] || `batch-${new Date().toISOString().slice(0, 10)}`;
const pepper = process.env.TOKEN_PEPPER;

if (!Number.isInteger(count) || count < 1 || count > 100000) {
  console.error('Usage: TOKEN_PEPPER=<64 hex> node scripts/generate-tokens.mjs <count 1-100000> [batchRef]');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(pepper || '')) {
  console.error('TOKEN_PEPPER must be set to 64 hex characters, matching the Worker secret exactly.');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}

function makeCode() {
  // Rejection sampling: 256 is not a multiple of 32, so a plain modulo would
  // make the first eight letters of the alphabet very slightly more likely.
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      if (byte >= 224) continue;
      code += ALPHABET[byte % 32];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

const codes = new Set();
while (codes.size < count) codes.add(makeCode());

const rows = [...codes].map((code) => ({
  code,
  hmac: createHmac('sha256', Buffer.from(pepper, 'hex')).update(code).digest('hex'),
}));

const printFile = `tokens-${batchRef}-print.csv`;
const loadFile = `tokens-${batchRef}-load.sql`;

writeFileSync(printFile, `activation_code\n${rows.map((r) => r.code).join('\n')}\n`, { mode: 0o600 });
writeFileSync(
  loadFile,
  `-- ${batchRef}: ${rows.length} activation codes. Contains no recoverable codes.\n`
  + `INSERT INTO public.activation_tokens (token_hmac, batch_ref) VALUES\n`
  + rows.map((r) => `  ('${r.hmac}', '${batchRef.replace(/'/g, "''")}')`).join(',\n')
  + `\nON CONFLICT (token_hmac) DO NOTHING;\n`,
  { mode: 0o600 },
);

console.log(`Wrote ${rows.length} codes.`);
console.log(`  ${printFile}  clear codes, for the printer only. Delete after the print run.`);
console.log(`  ${loadFile}   hashes only, safe to load into Supabase.`);
console.log('Both filenames are covered by .gitignore. Check before you commit.');
