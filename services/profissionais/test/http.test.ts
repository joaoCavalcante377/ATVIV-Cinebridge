import test from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.ts';
import { RepositorioMemoria } from './apoio.ts';

const corpo = {
  nome: 'Ana Silva', email: 'ana@example.com', papeis: ['EDITOR'], competencias: [{ nome: 'Blender', nivel: 5 }],
  precoCentavos: 50_000, disponibilidade: { inicio: '2027-03-01', fim: '2027-03-30' }, localizacao: 'São Paulo',
};

test('cadastra, lista com filtros, detalha e avalia profissionais', async () => {
  const repo = new RepositorioMemoria();
  const app = criarApp({ repositorio: repo, mensageria: { conectada: true }, logger: false });
  try {
    const criado = await app.inject({ method: 'POST', url: '/profissionais', payload: corpo });
    assert.equal(criado.statusCode, 201, criado.body);
    const { id } = criado.json();
    assert.equal((await app.inject('/profissionais?papel=EDITOR&localizacao=Remoto')).json().length, 1);
    assert.equal((await app.inject('/profissionais?papel=DIRETOR')).json().length, 0);
    assert.equal((await app.inject('/profissionais?inicio=2027-03-10&fim=2027-04-10')).json().length, 0);
    assert.equal((await app.inject(`/profissionais/${id}`)).json().nome, 'Ana Silva');
    assert.equal((await app.inject('/profissionais/nao-existe')).statusCode, 404);
    const avaliado = await app.inject({ method: 'POST', url: `/profissionais/${id}/avaliacoes`, payload: { nota: 4, comentario: 'Bom', data: '2027-04-01' } });
    assert.equal(avaliado.statusCode, 201);
    assert.equal(avaliado.json().avaliacoes.length, 1);
  } finally { await app.close(); }
});

test('recusa dados inválidos e regras de domínio violadas', async () => {
  const app = criarApp({ repositorio: new RepositorioMemoria(), mensageria: { conectada: true }, logger: false });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/profissionais', payload: { ...corpo, papeis: ['ATOR'] } })).statusCode, 400);
    const invertido = { ...corpo, disponibilidade: { inicio: '2027-03-30', fim: '2027-03-01' } };
    assert.equal((await app.inject({ method: 'POST', url: '/profissionais', payload: invertido })).statusCode, 422);
  } finally { await app.close(); }
});

test('/health exige banco e RabbitMQ', async () => {
  const repo = new RepositorioMemoria();
  const mensageria = { conectada: true };
  const app = criarApp({ repositorio: repo, mensageria, logger: false });
  try {
    assert.deepEqual((await app.inject('/health')).json(), { status: 'ok', servico: 'cinebridge-profissionais', banco: 'ok', mensageria: 'ok' });
    mensageria.conectada = false;
    assert.equal((await app.inject('/health')).statusCode, 503);
    mensageria.conectada = true; repo.offline = true;
    assert.equal((await app.inject('/health')).json().banco, 'indisponivel');
  } finally { await app.close(); }
});
