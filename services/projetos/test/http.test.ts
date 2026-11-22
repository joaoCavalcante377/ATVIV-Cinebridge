import test from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.ts';
import { ServicoProjetos } from '../src/servico.ts';
import { MensageriaMemoria, RepositorioMemoria } from './apoio.ts';

function montar() {
  const repositorio = new RepositorioMemoria();
  const mensageria = new MensageriaMemoria();
  const app = criarApp({ servico: new ServicoProjetos(repositorio, mensageria), repositorio, mensageria, logger: false });
  return { app, repositorio, mensageria };
}

test('rotas de projetos cobrem criação, consulta, edição e finalização', async () => {
  const { app } = montar();
  try {
    const criado = await app.inject({ method: 'POST', url: '/projetos', payload: { titulo: 'Curta', tipoProjeto: 'documentario' } });
    assert.equal(criado.statusCode, 201, criado.body);
    const { id } = criado.json();
    assert.equal((await app.inject(`/projetos/${id}`)).json().tipoProjeto, 'documentario');
    assert.equal((await app.inject('/projetos?status=CRIADO')).json().length, 1);
    assert.equal((await app.inject('/projetos?status=OUTRO')).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `/projetos/${id}`, payload: { titulo: 'Curta 2' } })).json().titulo, 'Curta 2');
    assert.equal((await app.inject({ method: 'PATCH', url: `/projetos/${id}`, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `/projetos/${id}/finalizar`, payload: {} })).json().status, 'FINALIZADO');
    assert.equal((await app.inject({ method: 'POST', url: `/projetos/${id}/finalizar` })).statusCode, 409);
    assert.equal((await app.inject('/projetos/6f0a9b9e-0000-4000-8000-000000000000')).statusCode, 404);
  } finally { await app.close(); }
});

test('falha de publicação responde 503 e /health reflete banco e RabbitMQ', async () => {
  const { app, mensageria, repositorio } = montar();
  try {
    mensageria.falhar = true;
    assert.equal((await app.inject({ method: 'POST', url: '/projetos', payload: { titulo: 'x' } })).statusCode, 503);
    assert.equal((await app.inject('/health')).statusCode, 200);
    mensageria.conectada = false;
    assert.equal((await app.inject('/health')).json().mensageria, 'indisponivel');
    mensageria.conectada = true; repositorio.offline = true;
    assert.equal((await app.inject('/health')).statusCode, 503);
  } finally { await app.close(); }
});
