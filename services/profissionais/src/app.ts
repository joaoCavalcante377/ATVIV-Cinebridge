import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { ErroDominio, PAPEIS, filtrar, validarAvaliacao, validarProfissional } from './dominio.ts';
import type { Avaliacao, Papel, Profissional, RepositorioProfissionais } from './dominio.ts';

const data = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const texto = { type: 'string', minLength: 1, maxLength: 200 };
const nivel = { type: 'number', minimum: 0, maximum: 5 };
const papel = { type: 'string', enum: PAPEIS };
const avaliacao = { type: 'object', additionalProperties: false, required: ['nota', 'comentario', 'data'],
  properties: { nota: nivel, comentario: { type: 'string', maxLength: 2_000 }, data } };
const profissionalSchema = {
  type: 'object', additionalProperties: false,
  required: ['nome', 'email', 'papeis', 'competencias', 'precoCentavos', 'disponibilidade', 'localizacao'],
  properties: {
    nome: texto, email: { type: 'string', format: 'email', maxLength: 254 },
    papeis: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: papel },
    competencias: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['nome', 'nivel'], properties: { nome: texto, nivel } } },
    precoCentavos: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, localizacao: texto,
    disponibilidade: { type: 'object', additionalProperties: false, required: ['inicio', 'fim'], properties: { inicio: data, fim: data } },
    historico: { type: 'array', maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['genero', 'tipoCaptacao', 'papel'],
      properties: { genero: texto, tipoCaptacao: { type: 'string', enum: ['documentario', 'ficcao', 'animacao'] }, papel, projetoId: texto, nota: nivel },
    } },
    avaliacoes: { type: 'array', maxItems: 100, items: avaliacao },
  },
};
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } };
const listaQuery = { type: 'object', additionalProperties: false, properties: {
  papel, localizacao: texto, inicio: data, fim: data, limite: { type: 'integer', minimum: 1, maximum: 1000 },
} };

export interface Dependencias {
  repositorio: RepositorioProfissionais;
  /** Estado da conexão com o RabbitMQ, considerado no /health. */
  mensageria: { readonly conectada: boolean };
  logger?: boolean;
}

export function criarApp({ repositorio, mensageria, logger = true }: Dependencias) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array' } } });

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

  /** Operacional somente com banco e RabbitMQ disponíveis (usado pelo healthcheck do Compose). */
  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    const banco = await repositorio.verificar().then(() => 'ok', () => 'indisponivel');
    const mq = mensageria.conectada ? 'ok' : 'indisponivel';
    const ok = banco === 'ok' && mq === 'ok';
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'indisponivel', servico: 'cinebridge-profissionais', banco, mensageria: mq });
  });

  type NovoProfissional = Omit<Profissional, 'id' | 'historico' | 'avaliacoes'> & Partial<Pick<Profissional, 'historico' | 'avaliacoes'>>;
  app.post<{ Body: NovoProfissional }>('/profissionais', { schema: { body: profissionalSchema } }, async (request, reply) => {
    const profissional: Profissional = { historico: [], avaliacoes: [], ...request.body, id: randomUUID() };
    const erros = validarProfissional(profissional);
    if (erros.length) throw new ErroDominio(erros.join(' '));
    await repositorio.salvar(profissional);
    request.log.info({ acao: 'profissional.cadastrado', profissionalId: profissional.id }, 'Cadastro concluído');
    return reply.code(201).send(profissional);
  });

  app.get<{ Querystring: { papel?: Papel; localizacao?: string; inicio?: string; fim?: string; limite?: number } }>('/profissionais',
    { schema: { querystring: listaQuery } }, async request => {
      const { papel: p, localizacao, inicio, fim, limite } = request.query;
      return filtrar(await repositorio.listar(), {
        ...(p ? { papeis: [p] } : {}), ...(localizacao ? { localizacao } : {}), ...(limite ? { limite } : {}),
        ...(inicio && fim ? { periodo: { inicio, fim } } : {}),
      });
    });

  app.get<{ Params: { id: string } }>('/profissionais/:id', { schema: { params: idParams } }, async request => {
    const profissional = await repositorio.buscar(request.params.id);
    if (!profissional) throw new ErroDominio('Profissional não encontrado', 404);
    return profissional;
  });

  app.post<{ Params: { id: string }; Body: Avaliacao }>('/profissionais/:id/avaliacoes', { schema: { params: idParams, body: avaliacao } },
    async (request, reply) => {
      validarAvaliacao(request.body);
      return reply.code(201).send(await repositorio.avaliar(request.params.id, request.body));
    });

  return app;
}
