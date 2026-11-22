import Fastify from 'fastify';
import { ErroDominio, STATUS } from './dominio.ts';
import type { RepositorioProjetos, StatusProjeto } from './dominio.ts';
import type { AlteracaoProjeto, NovoProjeto, ServicoProjetos } from './servico.ts';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const titulo = { type: 'string', minLength: 1, maxLength: 200 };
const dados = { type: 'object', maxProperties: 50 };

export interface Dependencias {
  servico: ServicoProjetos;
  repositorio: Pick<RepositorioProjetos, 'verificar'>;
  mensageria: { readonly conectada: boolean };
  logger?: boolean;
}

export function criarApp({ servico, repositorio, mensageria, logger = true }: Dependencias) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });

  app.setErrorHandler((falha, request, reply) => {
    const erro = falha instanceof Error ? falha : new Error(String(falha));
    const status = (erro as { status?: unknown }).status;
    if (erro instanceof ErroDominio || (erro.name === 'ErroRemoto' && typeof status === 'number')) return reply.code(status as number).send({ erro: erro.message });
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
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'indisponivel', servico: 'cinebridge-projetos', banco, mensageria: mq });
  });

  app.get<{ Querystring: { status?: StatusProjeto } }>('/projetos', { schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: STATUS } },
  } } }, async request => servico.listar(request.query.status));

  app.get<{ Params: { id: string } }>('/projetos/:id', { schema: { params: idParams } }, async request => servico.buscar(request.params.id));

  app.post<{ Body: NovoProjeto }>('/projetos', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['titulo'],
    properties: { titulo, tipoProjeto: { type: 'string', minLength: 1, maxLength: 50 }, dados },
  } } }, async (request, reply) => reply.code(201).send(await servico.criar(request.body)));

  app.patch<{ Params: { id: string }; Body: AlteracaoProjeto }>('/projetos/:id', { schema: { params: idParams, body: {
    type: 'object', additionalProperties: false, minProperties: 1, properties: { titulo, dados },
  } } }, async request => servico.atualizar(request.params.id, request.body));

  // O corpo é opcional ({ resumo }), por isso a validação é feita aqui e não pelo schema.
  app.post<{ Params: { id: string }; Body: unknown }>('/projetos/:id/finalizar', { schema: { params: idParams } }, async request => {
    const corpo = request.body ?? {};
    const resumo = typeof corpo === 'object' && corpo !== null ? (corpo as { resumo?: unknown }).resumo : undefined;
    if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo) || (resumo !== undefined && (typeof resumo !== 'string' || resumo.length > 500))) {
      throw new ErroDominio('Envie {} ou { "resumo": "texto de até 500 caracteres" }', 400);
    }
    return servico.finalizar(request.params.id, resumo as string | undefined);
  });

  return app;
}
