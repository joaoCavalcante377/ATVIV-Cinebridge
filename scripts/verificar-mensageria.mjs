#!/usr/bin/env node
/**
 * Cada microsserviço tem sua cópia de mensageria.ts (são implantados e versionados de forma
 * independente, sem pacote compartilhado). Este script garante que as cópias continuam idênticas.
 *   node scripts/verificar-mensageria.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const copias = [
  'services/api/src/infrastructure/mensageria.ts',
  'services/profissionais/src/mensageria.ts',
  'services/projetos/src/mensageria.ts',
  'services/notificacoes/src/mensageria.ts',
];
// Normaliza CRLF para que um checkout no Windows não gere falso alarme.
const hashes = copias.map(c => createHash('sha256').update(readFileSync(raiz + c, 'utf8').replace(/\r\n/g, '\n')).digest('hex'));
for (const [i, c] of copias.entries()) console.log(`${hashes[i].slice(0, 12)}  ${c}`);
if (new Set(hashes).size !== 1) {
  console.error('\nAs cópias de mensageria.ts divergem. Edite uma delas e copie para as demais.');
  process.exit(1);
}
console.log('\nAs 4 cópias de mensageria.ts são idênticas.');
