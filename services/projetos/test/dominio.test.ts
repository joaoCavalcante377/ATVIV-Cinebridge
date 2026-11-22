import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarEventoRecomendacao, validarEventoRecomendacao } from '../src/dominio.ts';
import type { Projeto } from '../src/dominio.ts';
import { eventoApi } from './apoio.ts';

const ID = '7d3f3c1e-1111-4111-8111-111111111111';

test('o ciclo de eventos do recomendador conduz o projeto até FINALIZADO', () => {
  let projeto: Projeto | null = null;
  const tipos: string[] = [];
  const aplicar = (evento: ReturnType<typeof eventoApi>) => {
    const r = aplicarEventoRecomendacao(projeto, evento);
    projeto = r.projeto; tipos.push(r.publicar.tipo);
    return r;
  };
  const criado = aplicar(eventoApi('recomendacao.gerada', ID, { destinatarios: [`produtor:${ID}`, 'profissional:a', 'profissional:b'] }));
  assert.equal(criado.publicar.tipo, 'projeto.criado');
  assert.deepEqual(criado.publicar.destinatarios, [`produtor:${ID}`, 'profissional:a', 'profissional:b']);
  assert.equal(criado.projeto.titulo, 'Entre cenas');
  assert.equal(criado.projeto.dados.orcamentoCentavos, 600_000);
  aplicar(eventoApi('convite.criado', ID, { papel: 'EDITOR', profissionalId: 'a' }, { status: 'AGUARDANDO' }));
  aplicar(eventoApi('convite.respondido', ID, { resposta: 'RECUSADO', profissionalId: 'a' }, { status: 'AGUARDANDO' }));
  aplicar(eventoApi('convite.respondido', ID, { resposta: 'ACEITO', profissionalId: 'b' }, { status: 'CONFIRMADA' }));
  const confirmado = aplicar(eventoApi('equipe.confirmada', ID, {}, { status: 'CONFIRMADA' }));
  assert.equal(confirmado.projeto.status, 'EQUIPE_CONFIRMADA');
  const final = aplicar(eventoApi('pagamentos.processados', ID, { pagamentos: [{ valorCentavos: 40_000 }, { valorCentavos: 50_000 }] }, { status: 'CONFIRMADA' }));
  assert.equal(final.publicar.tipo, 'projeto.finalizado');
  assert.equal(final.projeto.status, 'FINALIZADO');
  assert.ok(final.projeto.finalizadoEm);
  assert.deepEqual({ ...final.projeto.metricas }, {
    recomendacoes: 1, convitesEmitidos: 1, convitesAceitos: 1, convitesRecusados: 1, substituicoes: 0,
    equipeStatus: 'CONFIRMADA', custoEquipeCentavos: 90_000, integrantes: 2, papeisPendentes: [], pagamentosCentavos: 90_000,
  });
  assert.equal(final.projeto.versao, 6);
  assert.equal(final.projeto.resultados.length, 6);
  assert.deepEqual(tipos, ['projeto.criado', 'projeto.atualizado', 'projeto.atualizado', 'projeto.atualizado', 'projeto.atualizado', 'projeto.finalizado']);
  // Um evento tardio não reabre um projeto finalizado; equipe.reaberta reabre.
  assert.equal(aplicar(eventoApi('convites.cancelados', ID, {}, { status: 'SUGERIDA' })).projeto.status, 'FINALIZADO');
  const reaberto = aplicar(eventoApi('equipe.reaberta', ID, {}, { status: 'SUGERIDA' })).projeto;
  assert.equal(reaberto.status, 'EM_ANDAMENTO');
  assert.equal(reaberto.finalizadoEm, null);
});

test('detalhes do evento omitem rankings e destinatário padrão é o produtor', () => {
  const evento = eventoApi('membro.substituido', ID, { papel: 'EDITOR', anterior: 'x', equipe: { membros: [] }, destinatarios: [] });
  const { publicar } = aplicarEventoRecomendacao(null, evento);
  assert.deepEqual(publicar.detalhes, { papel: 'EDITOR', anterior: 'x' });
  assert.deepEqual(publicar.destinatarios, [`produtor:${ID}`]);
  assert.equal(publicar.id, `projetos:${evento.id}`);
  assert.throws(() => validarEventoRecomendacao({ tipo: 'x' }), /inválido/);
});
