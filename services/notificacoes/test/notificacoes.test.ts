import test from 'node:test';
import assert from 'node:assert/strict';
import { compor, validarEvento } from '../src/dominio.ts';
import type { EventoProjeto, FiltroNotificacoes, Notificacao, RepositorioNotificacoes } from '../src/dominio.ts';
import { CentralEventosProjeto, NotificadorEmail, NotificadorInterno } from '../src/observadores.ts';
import type { ObservadorProjeto } from '../src/observadores.ts';
import { criarApp } from '../src/app.ts';

class RepositorioMemoria implements RepositorioNotificacoes {
  dados = new Map<string, Notificacao>();
  offline = false;
  async salvar(n: Notificacao): Promise<boolean> {
    if (this.dados.has(n.id)) return false;
    this.dados.set(n.id, structuredClone(n)); return true;
  }
  async listar(f: FiltroNotificacoes): Promise<Notificacao[]> {
    return [...this.dados.values()].filter(n => (!f.projetoId || n.projetoId === f.projetoId)
      && (!f.destinatario || n.destinatario === f.destinatario) && (!f.canal || n.canal === f.canal)).slice(0, f.limite ?? 200);
  }
  async buscar(id: string): Promise<Notificacao | null> { return this.dados.get(id) ?? null; }
  async verificar(): Promise<void> { if (this.offline) throw new Error('offline'); }
}
const log = { info: () => {}, warn: () => {}, error: () => {} };

function evento(alteracoes: Partial<EventoProjeto> = {}): EventoProjeto {
  return validarEvento({
    id: 'projetos:evento-1', tipo: 'projeto.criado', projetoId: 'p1', ocorridoEm: '2027-01-01T00:00:00.000Z',
    motivo: 'recomendacao.gerada', origem: 'cinebridge-api', titulo: 'Entre cenas', status: 'EM_ANDAMENTO',
    destinatarios: ['produtor:p1', 'profissional:a'], metricas: { integrantes: 2, custoEquipeCentavos: 90_000, equipeStatus: 'SUGERIDA' },
    detalhes: {}, ...alteracoes,
  });
}

test('central notifica todos os canais assinantes sem duplicar na reentrega', async () => {
  const repo = new RepositorioMemoria();
  const central = new CentralEventosProjeto();
  central.assinar(new NotificadorEmail(repo, log));
  central.assinar(new NotificadorInterno(repo, log));
  assert.deepEqual(central.assinantes, ['email', 'interno']);
  await central.notificar(evento());
  await central.notificar(evento());
  assert.equal(repo.dados.size, 4, '2 destinatários × 2 canais, uma única vez');
  const produtor = (await repo.listar({ destinatario: 'produtor:p1', canal: 'email' }))[0]!;
  assert.equal(produtor.assunto, 'Projeto "Entre cenas" criado');
  assert.match(produtor.mensagem, /2 integrante\(s\), custo de R\$\s?900,00/);
  assert.throws(() => central.assinar(new NotificadorEmail(repo, log)), /já assinado/);
  central.remover('interno');
  assert.deepEqual(central.assinantes, ['email']);
});

test('falha de um observador é propagada para a mensagem voltar à fila', async () => {
  const repo = new RepositorioMemoria();
  const central = new CentralEventosProjeto();
  const quebrado: ObservadorProjeto = { nome: 'quebrado', atualizar: async () => { throw new Error('SMTP fora'); } };
  central.assinar(new NotificadorInterno(repo, log));
  central.assinar(quebrado);
  await assert.rejects(central.notificar(evento()), /quebrado: SMTP fora/);
  assert.equal(repo.dados.size, 2, 'o canal que funcionou gravou');
});

test('mensagens variam por motivo e por destinatário', () => {
  assert.match(compor(evento({ motivo: 'convite.criado', tipo: 'projeto.atualizado', detalhes: { papel: 'EDITOR' } }), 'profissional:a').mensagem, /convidado para atuar como EDITOR/);
  assert.match(compor(evento({ motivo: 'convite.respondido', tipo: 'projeto.atualizado', detalhes: { resposta: 'RECUSADO' } }), 'produtor:p1').assunto, /recusado/);
  assert.match(compor(evento({ motivo: 'pagamentos.processados', tipo: 'projeto.finalizado', metricas: { pagamentosCentavos: 12_345 } }), 'produtor:p1').mensagem, /R\$\s?123,45/);
  assert.match(compor(evento({ motivo: 'recomendacao.gerada' }), 'profissional:a').assunto, /sugerido/);
  assert.match(compor(evento({ motivo: 'algo.novo' }), 'produtor:p1').mensagem, /algo\.novo/);
  assert.deepEqual(validarEvento({ id: 'e', tipo: 'projeto.finalizado', projetoId: 'p9', ocorridoEm: 'x' }).destinatarios, ['produtor:p9']);
  assert.throws(() => validarEvento({ id: 'e', tipo: 'outro', projetoId: 'p', ocorridoEm: 'x' }), /inválido/);
});

test('rotas listam por projeto, destinatário e canal; /health exige banco e RabbitMQ', async () => {
  const repo = new RepositorioMemoria();
  const central = new CentralEventosProjeto();
  central.assinar(new NotificadorEmail(repo, log));
  await central.notificar(evento());
  const mensageria = { conectada: true };
  const app = criarApp({ repositorio: repo, mensageria, assinantes: () => central.assinantes, logger: false });
  try {
    assert.equal((await app.inject('/notificacoes?projetoId=p1')).json().length, 2);
    const lista = (await app.inject('/notificacoes?destinatario=profissional:a&canal=email')).json();
    assert.equal(lista.length, 1);
    assert.equal((await app.inject(`/notificacoes/${lista[0].id}`)).json().destinatario, 'profissional:a');
    assert.equal((await app.inject(`/notificacoes/${'0'.repeat(64)}`)).statusCode, 404);
    assert.equal((await app.inject('/notificacoes?canal=sms')).statusCode, 400);
    assert.deepEqual((await app.inject('/health')).json().observadores, ['email']);
    mensageria.conectada = false;
    assert.equal((await app.inject('/health')).statusCode, 503);
  } finally { await app.close(); }
});
