import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { ErroRemoto, FILAS, Mensageria } from '../../src/infrastructure/mensageria.ts';

/**
 * Mensageria contra um RabbitMQ real, em um vhost temporário (não interfere na stack em execução).
 * Requer TEST_AMQP_URL, por exemplo amqp://guest:guest@127.0.0.1:5672, e a interface de
 * gerenciamento (porta 15672 ou TEST_MQ_GERENCIAMENTO) para criar e remover o vhost.
 */
const base = process.env.TEST_AMQP_URL;
const vhost = `cinebridge-teste-${randomUUID().slice(0, 8)}`;

describe('Mensageria com RabbitMQ real', { skip: base ? false : 'defina TEST_AMQP_URL para executar' }, () => {
  const url = new URL(base ?? 'amqp://guest:guest@127.0.0.1:5672');
  const gerenciamento = process.env.TEST_MQ_GERENCIAMENTO ?? `http://${url.hostname}:15672`;
  const autorizacao = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username || 'guest')}:${decodeURIComponent(url.password || 'guest')}`).toString('base64');
  const amqpUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}/${vhost}`;
  const abertas: Mensageria[] = [];
  const nova = (servico: string, consultas = false) => { const m = new Mensageria(amqpUrl, { servico, consultas }); abertas.push(m); return m; };
  const api = (metodo: string, caminho: string, corpo?: unknown) => fetch(`${gerenciamento}/api${caminho}`, {
    method: metodo, headers: { authorization: autorizacao, 'content-type': 'application/json' }, ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  const contar = async (fila: string): Promise<number> => {
    const conexao = await amqp.connect(amqpUrl);
    try { const canal = await conexao.createChannel(); return (await canal.checkQueue(fila)).messageCount; }
    finally { await conexao.close(); }
  };
  const esperar = async (condicao: () => boolean | Promise<boolean>, ms = 5_000) => {
    const limite = Date.now() + ms;
    while (Date.now() < limite) { if (await condicao()) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('condição não atingida');
  };

  before(async () => {
    assert.equal((await api('PUT', `/vhosts/${vhost}`)).ok, true, 'criar vhost');
    assert.equal((await api('PUT', `/permissions/${vhost}/${decodeURIComponent(url.username || 'guest')}`, { configure: '.*', write: '.*', read: '.*' })).ok, true);
  });
  after(async () => {
    for (const m of abertas) await m.fechar();
    await api('DELETE', `/vhosts/${vhost}`);
  });

  it('declara as filas duráveis com fila de falhas e responde consultas RPC pelo correlationId', async () => {
    const servidor = nova('profissionais-teste');
    servidor.responder(FILAS.consultaProfissionais, async pedido => {
      const p = pedido as { operacao: string; valor?: number };
      if (p.operacao === 'dobrar') return (p.valor ?? 0) * 2;
      if (p.operacao === 'ausente') throw Object.assign(new Error('Profissional não encontrado'), { status: 404 });
      throw new Error('detalhe interno');
    });
    const cliente = nova('api-teste', true);
    servidor.iniciar(); cliente.iniciar();
    await Promise.all([servidor.aguardarConexao(10_000), cliente.aguardarConexao(10_000)]);
    const respostas = await Promise.all([1, 2, 3].map(valor => cliente.consultar<number>(FILAS.consultaProfissionais, { operacao: 'dobrar', valor })));
    assert.deepEqual(respostas, [2, 4, 6]);
    await assert.rejects(cliente.consultar(FILAS.consultaProfissionais, { operacao: 'ausente' }),
      (e: unknown) => e instanceof ErroRemoto && e.status === 404 && e.message === 'Profissional não encontrado');
    await assert.rejects(cliente.consultar(FILAS.consultaProfissionais, { operacao: 'quebrar' }),
      (e: unknown) => e instanceof ErroRemoto && e.status === 500 && !e.message.includes('detalhe interno'));
    const filas = await (await api('GET', `/queues/${vhost}`)).json() as { name: string; durable: boolean; arguments: Record<string, string> }[];
    const consulta = filas.find(f => f.name === FILAS.consultaProfissionais)!;
    assert.equal(consulta.durable, true);
    assert.equal(consulta.arguments['x-dead-letter-routing-key'], 'consulta-profissionais.falhas');
    for (const nome of Object.values(FILAS)) assert.ok(filas.some(f => f.name === `${nome}.falhas` && f.durable), nome);
    assert.ok(filas.some(f => f.name.startsWith('api-teste.respostas.')), 'fila de retorno exclusiva do cliente');
    assert.ok(!filas.some(f => f.name.startsWith('profissionais-teste.respostas.')), 'quem não consulta não cria fila de retorno');
  });

  it('consulta sem consumidor expira com 504', async () => {
    const cliente = nova('api-timeout', true);
    cliente.iniciar(); await cliente.aguardarConexao(10_000);
    const inicio = Date.now();
    await assert.rejects(cliente.consultar(FILAS.consultaProjetos, { operacao: 'buscar', id: 'x' }, 300), (e: unknown) => e instanceof ErroRemoto && e.status === 504);
    assert.ok(Date.now() - inicio < 2_000);
    // O pedido expira na fila e não fica para um consumidor que apareça depois.
    await esperar(async () => (await contar(FILAS.consultaProjetos)) === 0);
  });

  it('publica com confirmação, reentrega uma falha e envia a segunda para a fila de falhas', async () => {
    const produtor = nova('projetos-teste');
    const consumidor = nova('notificacoes-teste');
    const tentativas = new Map<string, number>();
    const processadas: string[] = [];
    consumidor.consumir(FILAS.eventosProjetos, async conteudo => {
      const { id, falhar } = conteudo as { id: string; falhar: 'uma' | 'sempre' | 'nunca' };
      const n = (tentativas.get(id) ?? 0) + 1;
      tentativas.set(id, n);
      if (falhar === 'sempre' || (falhar === 'uma' && n === 1)) throw new Error(`falha ${id}`);
      processadas.push(id);
    });
    produtor.iniciar(); consumidor.iniciar();
    await Promise.all([produtor.aguardarConexao(10_000), consumidor.aguardarConexao(10_000)]);
    await produtor.publicar(FILAS.eventosProjetos, { id: 'ok', falhar: 'nunca' });
    await produtor.publicar(FILAS.eventosProjetos, { id: 'transitoria', falhar: 'uma' });
    await produtor.publicar(FILAS.eventosProjetos, { id: 'definitiva', falhar: 'sempre' });
    await esperar(() => processadas.length === 2 && tentativas.get('definitiva') === 2);
    assert.deepEqual(processadas.sort(), ['ok', 'transitoria']);
    assert.equal(tentativas.get('transitoria'), 2);
    await esperar(async () => (await contar('eventos-projetos.falhas')) === 1);
    assert.equal(await contar(FILAS.eventosProjetos), 0);
  });

  it('publicar sem conexão falha com 503 e a mensageria reconecta sozinha', async () => {
    const m = nova('reconexao-teste');
    await assert.rejects(m.publicar(FILAS.eventosProjetos, {}), (e: unknown) => e instanceof ErroRemoto && e.status === 503);
    m.iniciar(); await m.aguardarConexao(10_000);
    assert.equal(m.conectada, true);
    // Derruba as conexões deste vhost pelo gerenciamento e espera a reconexão.
    // A lista de conexões do gerenciamento é atualizada com alguns segundos de atraso.
    let alvo: { name: string } | undefined;
    await esperar(async () => {
      const conexoes = await (await api('GET', `/vhosts/${vhost}/connections`)).json() as { name: string; client_properties: { connection_name?: string } }[];
      alvo = conexoes.find(c => c.client_properties.connection_name === 'reconexao-teste');
      return alvo !== undefined;
    }, 15_000);
    await api('DELETE', `/connections/${encodeURIComponent(alvo!.name)}`);
    await esperar(() => !m.conectada);
    await esperar(() => m.conectada, 10_000);
    await m.publicar(FILAS.eventosRecomendacoes, { depois: 'da reconexão' });
    assert.equal(await contar(FILAS.eventosRecomendacoes), 1);
  });
});
