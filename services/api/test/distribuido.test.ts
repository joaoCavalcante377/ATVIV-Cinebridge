import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { criarApp } from '../src/http/app.ts';
import { AdaptadorProfissionaisMQ } from '../src/infrastructure/adaptadores/profissionais-mq.ts';
import { ErroRemoto } from '../src/infrastructure/mensageria.ts';
import { RepositorioMemoria, profissionais, projeto } from './support.ts';

/** Dublê do RabbitMQ: responde às consultas como os serviços de profissionais e de projetos. */
class MensageriaMemoria {
  conectada = true;
  publicadas: { fila: string; conteudo: unknown; messageId?: string }[] = [];
  consultas: { fila: string; pedido: unknown }[] = [];
  falharPublicacao = false;
  responder: (fila: string, pedido: Record<string, unknown>) => unknown = (fila, pedido) => {
    if (fila === 'consulta-profissionais' && pedido.operacao === 'listar') return profissionais();
    if (fila === 'consulta-projetos') throw new ErroRemoto('Projeto não encontrado', 404);
    throw new ErroRemoto('não suportado', 400);
  };
  async publicar(fila: string, conteudo: unknown, propriedades: { messageId?: string } = {}): Promise<void> {
    if (this.falharPublicacao) throw new ErroRemoto('O RabbitMQ não confirmou a publicação', 503);
    this.publicadas.push({ fila, conteudo: structuredClone(conteudo), messageId: propriedades.messageId });
  }
  async consultar<T>(fila: string, pedido: unknown): Promise<T> {
    this.consultas.push({ fila, pedido });
    return structuredClone(this.responder(fila, pedido as Record<string, unknown>)) as T;
  }
}

test('modo distribuído: recomenda com profissionais vindos da fila e publica a outbox no RabbitMQ', async () => {
  const repo = new RepositorioMemoria();
  repo.profissionais = []; // a tabela local não é usada
  const mq = new MensageriaMemoria();
  const { app, worker } = criarApp(repo, { logger: false, worker: false, mensageria: mq });
  try {
    const resposta = await app.inject({ method: 'POST', url: '/projetos', payload: projeto() });
    assert.equal(resposta.statusCode, 201, resposta.body);
    const estado = resposta.json();
    assert.equal(estado.equipe.status, 'SUGERIDA');
    assert.deepEqual(mq.consultas[0], { fila: 'consulta-profissionais', pedido: { operacao: 'listar', criterios: {} } });
    await worker.processar();
    assert.equal(mq.publicadas.length, 1);
    const [publicada] = mq.publicadas;
    assert.equal(publicada!.fila, 'eventos-recomendacoes');
    const evento = publicada!.conteudo as { id: string; tipo: string; dados: { contexto: { projeto: { titulo: string }; equipe: { integrantes: number } } } };
    assert.equal(publicada!.messageId, evento.id);
    assert.equal(evento.tipo, 'recomendacao.gerada');
    assert.equal(evento.dados.contexto.projeto.titulo, 'Curta da turma');
    assert.equal(evento.dados.contexto.equipe.integrantes, 2);
    assert.equal(repo.notificacoes.size, 0, 'notificações locais desativadas');
    assert.ok(repo.auditorias.size > 0, 'auditoria local mantida');
  } finally { await app.close(); }
});

test('modo distribuído: falha de publicação mantém o evento pendente para nova tentativa', async () => {
  const repo = new RepositorioMemoria();
  const mq = new MensageriaMemoria();
  const { app, worker } = criarApp(repo, { logger: false, worker: false, mensageria: mq });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/projetos', payload: projeto() })).statusCode, 201);
    mq.falharPublicacao = true;
    await worker.processar();
    assert.equal((await repo.statusEventos()).pendentes, 1);
    mq.falharPublicacao = false;
    await worker.processar();
    assert.equal((await repo.statusEventos()).pendentes, 0);
    assert.equal(mq.publicadas.length, 1);
  } finally { await app.close(); }
});

test('modo distribuído: rotas, acompanhamento via consulta-projetos e /health com RabbitMQ', async () => {
  const repo = new RepositorioMemoria();
  const mq = new MensageriaMemoria();
  const { app } = criarApp(repo, { logger: false, worker: false, mensageria: mq });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/profissionais', payload: {} })).statusCode, 404, 'cadastro mudou de serviço');
    const { projeto: { id } } = (await app.inject({ method: 'POST', url: '/projetos', payload: projeto() })).json();
    assert.equal((await app.inject(`/projetos/${id}/notificacoes`)).statusCode, 404);
    assert.equal((await app.inject(`/projetos/${id}/acompanhamento`)).statusCode, 404, 'ainda não registrado');
    mq.responder = (fila, pedido) => ({ id: pedido.id, status: 'EM_ANDAMENTO', fila });
    const acompanhamento = await app.inject(`/projetos/${id}/acompanhamento`);
    assert.deepEqual(acompanhamento.json(), { id, status: 'EM_ANDAMENTO', fila: 'consulta-projetos' });
    mq.responder = () => { throw new ErroRemoto('Sem resposta', 504); };
    assert.equal((await app.inject(`/projetos/${id}/acompanhamento`)).statusCode, 503);
    assert.equal((await app.inject(`/projetos/${randomUUID()}/acompanhamento`)).statusCode, 404);
    assert.deepEqual((await app.inject('/health')).json(), { status: 'ok', servico: 'cinebridge-api', banco: 'ok', mensageria: 'ok' });
    mq.conectada = false;
    assert.equal((await app.inject('/health')).statusCode, 503);
    mq.conectada = true;
    repo.verificar = async () => { throw new Error('offline'); };
    assert.equal((await app.inject('/health')).json().banco, 'indisponivel');
  } finally { await app.close(); }
});

test('modo distribuído: sem resposta do serviço de profissionais a recomendação é degradada, não um erro', async () => {
  const repo = new RepositorioMemoria();
  const mq = new MensageriaMemoria();
  mq.responder = () => { throw new ErroRemoto('Sem resposta da fila consulta-profissionais', 504); };
  const { app } = criarApp(repo, { logger: false, worker: false, mensageria: mq });
  try {
    const resposta = await app.inject({ method: 'POST', url: '/projetos', payload: projeto() });
    assert.equal(resposta.statusCode, 201);
    assert.equal(resposta.json().recomendacao.degradada, true);
    assert.equal(resposta.json().equipe.status, 'PARCIAL');
  } finally { await app.close(); }
});

test('AdaptadorProfissionaisMQ traduz pedidos, filtra e converte erros remotos', async () => {
  const mq = new MensageriaMemoria();
  const adaptador = new AdaptadorProfissionaisMQ(mq);
  const editores = await adaptador.listarProfissionais({ papeis: ['EDITOR'] });
  assert.deepEqual(editores.map(p => p.dados.id), ['editor-1', 'editor-2']);
  mq.responder = (_fila, pedido) => pedido.operacao === 'detalhar' ? profissionais()[0] : null;
  assert.equal((await adaptador.detalharProfissional('diretor-1')).dados.id, 'diretor-1');
  await adaptador.registrarAvaliacao('diretor-1', { nota: 4, comentario: 'Bom', data: '2027-01-01' });
  assert.deepEqual(mq.consultas.at(-1), { fila: 'consulta-profissionais', pedido: { operacao: 'avaliar', id: 'diretor-1', avaliacao: { nota: 4, comentario: 'Bom', data: '2027-01-01' } } });
  await assert.rejects(adaptador.registrarAvaliacao('x', { nota: 9, comentario: '', data: '2027-01-01' }), /entre 0 e 5/);
  await assert.rejects(adaptador.listarProfissionais(), /Resposta inválida/);
  mq.responder = () => { throw new ErroRemoto('x', 404); };
  await assert.rejects(adaptador.detalharProfissional('x'), (e: { status: number; message: string }) => e.status === 404 && /não encontrado/.test(e.message));
});
