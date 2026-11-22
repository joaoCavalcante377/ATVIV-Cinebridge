import test from 'node:test';
import assert from 'node:assert/strict';
import { filtrar, validarAvaliacao, validarProfissional } from '../src/dominio.ts';
import { profissionaisFicticios } from '../src/seed.ts';
import { profissional } from './apoio.ts';

test('seed contém os 27 profissionais válidos das atividades anteriores', () => {
  const lista = profissionaisFicticios();
  assert.equal(lista.length, 27);
  assert.equal(new Set(lista.map(p => p.id)).size, 27);
  for (const p of lista) assert.deepEqual(validarProfissional(p), [], p.id);
});

test('validação recusa disponibilidade invertida, competência repetida e papel inválido', () => {
  const erros = validarProfissional(profissional('x', {
    disponibilidade: { inicio: '2027-12-31', fim: '2027-01-01' },
    competencias: [{ nome: 'Edição', nivel: 3 }, { nome: 'edicao', nivel: 4 }],
    papeis: ['EDITOR', 'EDITOR'],
  }));
  assert.equal(erros.length, 3);
  assert.throws(() => validarAvaliacao({ nota: 6, comentario: '', data: '2027-01-01' }), /entre 0 e 5/);
  assert.throws(() => validarAvaliacao({ nota: 4, comentario: '', data: '2027-02-30' }), /AAAA-MM-DD/);
});

test('filtro considera papel, localização ou remoto e o período inteiro', () => {
  const lista = [
    profissional('sp'), profissional('rio', { localizacao: 'Rio de Janeiro' }), profissional('remoto', { localizacao: 'Remoto' }),
    profissional('diretor', { papeis: ['DIRETOR'] }), profissional('curto', { disponibilidade: { inicio: '2027-01-01', fim: '2027-01-10' } }),
  ];
  const ids = filtrar(lista, { papeis: ['EDITOR'], localizacao: 'sao paulo', periodo: { inicio: '2027-03-01', fim: '2027-03-30' } }).map(p => p.id);
  assert.deepEqual(ids, ['sp', 'remoto']);
  assert.equal(filtrar(lista, { limite: 2 }).length, 2);
  assert.equal(filtrar(lista, { localizacao: 'Remoto' }).length, 5);
});
