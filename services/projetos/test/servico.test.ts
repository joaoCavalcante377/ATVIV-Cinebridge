import test from 'node:test';
import assert from 'node:assert/strict';
import { ServicoProjetos } from '../src/servico.ts';
import { MensageriaMemoria, RepositorioMemoria, eventoApi } from './apoio.ts';

const ID = '7d3f3c1e-2222-4222-8222-222222222222';

test('evento reentregue não altera o projeto de novo e republica a mesma mensagem', async () => {
  const repo = new RepositorioMemoria();
  const mq = new MensageriaMemoria();
  const servico = new ServicoProjetos(repo, mq);
  const evento = eventoApi('recomendacao.gerada', ID);
  mq.falhar = true;
  await assert.rejects(servico.processarEventoRecomendacao(evento), /não confirmou/);
  assert.equal((await repo.buscar(ID))?.versao, 1, 'aplicado uma vez antes da falha de publicação');
  mq.falhar = false;
  await servico.processarEventoRecomendacao(evento);
  await servico.processarEventoRecomendacao(evento);
  assert.equal((await repo.buscar(ID))?.versao, 1);
  assert.equal((await repo.buscar(ID))?.metricas.recomendacoes, 1);
  assert.deepEqual(mq.publicadas.map(p => [p.fila, p.messageId]), [['eventos-projetos', `projetos:${evento.id}`], ['eventos-projetos', `projetos:${evento.id}`]]);
});

test('cadastro manual, edição e finalização publicam criado, atualizado e finalizado', async () => {
  const repo = new RepositorioMemoria();
  const mq = new MensageriaMemoria();
  const servico = new ServicoProjetos(repo, mq);
  const projeto = await servico.criar({ titulo: 'Festival', dados: { orcamentoCentavos: 10 } });
  assert.equal(projeto.status, 'CRIADO');
  await servico.atualizar(projeto.id, { dados: { genero: 'drama' } });
  const final = await servico.finalizar(projeto.id, 'Exibido no festival');
  assert.equal(final.status, 'FINALIZADO');
  assert.deepEqual(final.dados, { orcamentoCentavos: 10, genero: 'drama' });
  assert.deepEqual(mq.publicadas.map(p => (p.conteudo as { tipo: string }).tipo), ['projeto.criado', 'projeto.atualizado', 'projeto.finalizado']);
  await assert.rejects(servico.finalizar(projeto.id), (e: { status: number }) => e.status === 409);
  await assert.rejects(servico.atualizar(projeto.id, { titulo: 'x' }), (e: { status: number }) => e.status === 409);
});

test('sem confirmação do RabbitMQ o cadastro manual não é gravado', async () => {
  const repo = new RepositorioMemoria();
  const mq = new MensageriaMemoria();
  mq.falhar = true;
  await assert.rejects(new ServicoProjetos(repo, mq).criar({ titulo: 'x' }), (e: { status: number }) => e.status === 503);
  assert.equal(repo.projetos.size, 0);
});

test('consulta-projetos busca e lista por status', async () => {
  const repo = new RepositorioMemoria();
  const servico = new ServicoProjetos(repo, new MensageriaMemoria());
  await servico.processarEventoRecomendacao(eventoApi('recomendacao.gerada', ID));
  assert.equal(((await servico.atenderConsulta({ operacao: 'buscar', id: ID })) as { id: string }).id, ID);
  assert.equal(((await servico.atenderConsulta({ operacao: 'listar', status: 'EM_ANDAMENTO' })) as unknown[]).length, 1);
  await assert.rejects(servico.atenderConsulta({ operacao: 'buscar', id: 'x' }), (e: { status: number }) => e.status === 404);
  await assert.rejects(servico.atenderConsulta({ operacao: 'listar', status: 'X' }), (e: { status: number }) => e.status === 400);
  await assert.rejects(servico.atenderConsulta({}), (e: { status: number }) => e.status === 400);
});
