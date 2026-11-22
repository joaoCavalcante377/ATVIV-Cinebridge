import Fastify from 'fastify';
import { ErroDominio } from './dominio.ts';
import type { Canal, RepositorioNotificacoes } from './dominio.ts';

export interface Dependencias {
  repositorio: RepositorioNotificacoes;
  mensageria: { readonly conectada: boolean };
  assinantes: () => string[];
  logger?: boolean;
}

export function criarApp({ repositorio, mensageria, assinantes, logger = true }: Dependencias) {
  const app = Fastify({ logger, ajv: { customOptions: { removeAdditional: false, coerceTypes: true } } });

  app.setErrorHandler((falha, request, reply) => {
    const erro = falha instanceof Error ? falha : new Error(String(falha));
    if (erro instanceof ErroDominio) return reply.code(erro.status).send({ erro: erro.message });
    if ('validation' in erro && erro.validation) return reply.code(400).send({ erro: 'Dados inválidos', detalhes: erro.validation });
    if ('statusCode' in erro && typeof erro.statusCode === 'number' && erro.statusCode >= 400 && erro.statusCode < 500) {
      return reply.code(erro.statusCode).send({ erro: erro.message });
    }
    request.log.error({ err: erro }, 'Operação não concluída');
    return reply.code(500).send({ erro: 'Não foi possível concluir a operação' });
  });

  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    const banco = await repositorio.verificar().then(() => 'ok', () => 'indisponivel');
    const mq = mensageria.conectada ? 'ok' : 'indisponivel';
    const ok = banco === 'ok' && mq === 'ok';
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'indisponivel', servico: 'cinebridge-notificacoes', banco, mensageria: mq, observadores: assinantes() });
  });

  app.get<{ Querystring: { projetoId?: string; destinatario?: string; canal?: Canal; limite?: number } }>('/notificacoes', { schema: { querystring: {
    type: 'object', additionalProperties: false, properties: {
      projetoId: { type: 'string', minLength: 1, maxLength: 100 }, destinatario: { type: 'string', minLength: 1, maxLength: 200 },
      canal: { type: 'string', enum: ['email', 'interno'] }, limite: { type: 'integer', minimum: 1, maximum: 1000 },
    },
  } } }, async request => repositorio.listar(request.query));

  app.get<{ Params: { id: string } }>('/notificacoes/:id', { schema: { params: {
    type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
  } } }, async request => {
    const notificacao = await repositorio.buscar(request.params.id);
    if (!notificacao) throw new ErroDominio('Notificação não encontrada', 404);
    return notificacao;
  });

  return app;
}
