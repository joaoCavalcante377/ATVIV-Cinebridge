/**
 * Mensageria da Cinebridge sobre RabbitMQ (AMQP 0-9-1, biblioteca amqplib).
 *
 * Este arquivo é idêntico em todos os microsserviços (veja scripts/verificar-mensageria.mjs na raiz).
 * Cada serviço é implantado e versionado de forma independente, por isso não há pacote compartilhado.
 *
 * Garantias:
 * - filas de trabalho duráveis e mensagens persistentes (sobrevivem ao reinício do broker);
 * - publicação em canal de confirmação: `publicar` só resolve depois do ack do broker;
 * - consumo com ack manual: a mensagem só sai da fila depois de processada;
 * - uma falha é reentregue uma vez; na segunda, a mensagem vai para a fila `<fila>.falhas`;
 * - reconexão automática com espera crescente, refazendo filas e consumidores.
 */
import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';

export const FILAS = {
  /** RPC: o recomendador pede profissionais; o serviço de profissionais responde na fila de retorno. */
  consultaProfissionais: 'consulta-profissionais',
  /** RPC: o recomendador consulta o registro de um projeto no serviço de projetos. */
  consultaProjetos: 'consulta-projetos',
  /** Eventos do recomendador (outbox) para o serviço de projetos. */
  eventosRecomendacoes: 'eventos-recomendacoes',
  /** Eventos de ciclo de vida do projeto para o serviço de notificações. */
  eventosProjetos: 'eventos-projetos',
} as const;
export type NomeFila = typeof FILAS[keyof typeof FILAS];

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Erro devolvido por outro serviço em uma resposta RPC, com o status HTTP equivalente. */
export class ErroRemoto extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.name = 'ErroRemoto'; this.status = status; }
}

export interface RespostaRpc { ok: boolean; dados?: unknown; erro?: { mensagem: string; status: number } }
type Tarefa = (canal: ConfirmChannel) => Promise<void>;
interface Pendente { resolver: (valor: unknown) => void; rejeitar: (erro: Error) => void; timer: ReturnType<typeof setTimeout> }

export interface OpcoesMensageria {
  /** Nome do serviço, usado na fila de retorno e nos logs. */
  servico: string;
  logger?: Logger;
  /** Mensagens não confirmadas entregues ao mesmo tempo para este consumidor. */
  prefetch?: number;
  esperaMaximaMs?: number;
  /** Cria a fila de retorno para fazer consultas RPC (`consultar`). Só quem consulta precisa dela. */
  consultas?: boolean;
}

const silencioso: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export class Mensageria {
  private url: string;
  private servico: string;
  private log: Logger;
  private prefetch: number;
  private esperaMaximaMs: number;
  private fazConsultas: boolean;
  private conexao: ChannelModel | undefined;
  private canal: ConfirmChannel | undefined;
  private filaRetorno: string | undefined;
  private tarefas: Tarefa[] = [];
  private pendentes = new Map<string, Pendente>();
  private tentativa = 0;
  private encerrando = false;
  private religar: ReturnType<typeof setTimeout> | undefined;
  private esperando: (() => void)[] = [];

  constructor(url: string, opcoes: OpcoesMensageria) {
    this.url = url; this.servico = opcoes.servico; this.log = opcoes.logger ?? silencioso;
    this.prefetch = opcoes.prefetch ?? 10; this.esperaMaximaMs = opcoes.esperaMaximaMs ?? 15_000;
    this.fazConsultas = opcoes.consultas ?? false;
  }

  get conectada(): boolean { return this.canal !== undefined; }

  /** Permite usar o logger do Fastify, criado depois da mensageria. */
  definirLogger(logger: Logger): void { this.log = logger; }

  /** Inicia a conexão em segundo plano. Use `aguardarConexao` para esperar a primeira. */
  iniciar(): void { if (!this.conexao && !this.religar) void this.conectar(); }

  aguardarConexao(timeoutMs = 60_000): Promise<void> {
    if (this.canal) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RabbitMQ indisponível')), timeoutMs);
      this.esperando.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  private async conectar(): Promise<void> {
    this.religar = undefined;
    if (this.encerrando) return;
    try {
      const conexao = await amqp.connect(this.url, { clientProperties: { connection_name: this.servico } });
      conexao.on('error', erro => this.log.warn({ err: erro }, 'Erro na conexão com o RabbitMQ'));
      conexao.on('close', () => this.perderConexao());
      this.conexao = conexao;
      const canal = await conexao.createConfirmChannel();
      canal.on('error', erro => this.log.warn({ err: erro }, 'Erro no canal do RabbitMQ'));
      await canal.prefetch(this.prefetch);
      for (const fila of Object.values(FILAS)) await this.declarar(canal, fila);
      if (this.fazConsultas) {
        // Fila de retorno das consultas RPC: nome único por instância, exclusiva e temporária.
        this.filaRetorno = (await canal.assertQueue(`${this.servico}.respostas.${randomUUID()}`,
          { exclusive: true, autoDelete: true, durable: false })).queue;
        await canal.consume(this.filaRetorno, msg => this.receberResposta(msg), { noAck: true });
      }
      for (const tarefa of this.tarefas) await tarefa(canal);
      this.canal = canal; this.tentativa = 0;
      this.log.info({ servico: this.servico }, 'Conectado ao RabbitMQ');
      for (const avisar of this.esperando.splice(0)) avisar();
    } catch (erro) {
      this.log.warn({ err: erro }, 'Não foi possível conectar ao RabbitMQ; nova tentativa em instantes');
      await this.conexao?.close().catch(() => undefined);
      this.perderConexao();
    }
  }

  private perderConexao(): void {
    const tinhaCanal = this.canal !== undefined;
    this.canal = undefined; this.conexao = undefined; this.filaRetorno = undefined;
    for (const [id, pendente] of this.pendentes) {
      clearTimeout(pendente.timer); pendente.rejeitar(new ErroRemoto('Conexão com o RabbitMQ perdida', 503)); this.pendentes.delete(id);
    }
    if (this.encerrando || this.religar) return;
    if (tinhaCanal) this.log.warn({ servico: this.servico }, 'Conexão com o RabbitMQ perdida; reconectando');
    const espera = Math.min(this.esperaMaximaMs, 500 * 2 ** this.tentativa++);
    this.religar = setTimeout(() => void this.conectar(), espera);
  }

  /** Fila durável com fila de falhas associada (dead letter). */
  private async declarar(canal: ConfirmChannel, fila: string): Promise<void> {
    await canal.assertQueue(`${fila}.falhas`, { durable: true });
    await canal.assertQueue(fila, { durable: true, arguments: {
      'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': `${fila}.falhas`,
    } });
  }

  private exigirCanal(): ConfirmChannel {
    if (!this.canal) throw new ErroRemoto('Mensageria indisponível', 503);
    return this.canal;
  }

  /** Publica uma mensagem persistente e aguarda a confirmação do broker. */
  publicar(fila: string, conteudo: unknown, propriedades: { messageId?: string; type?: string } = {}): Promise<void> {
    let canal: ConfirmChannel;
    try { canal = this.exigirCanal(); } catch (erro) { return Promise.reject(erro); }
    const corpo = Buffer.from(JSON.stringify(conteudo));
    return new Promise((resolve, reject) => {
      canal.sendToQueue(fila, corpo, {
        persistent: true, contentType: 'application/json', timestamp: Math.floor(Date.now() / 1000),
        appId: this.servico, messageId: propriedades.messageId ?? randomUUID(), ...(propriedades.type ? { type: propriedades.type } : {}),
      }, erro => erro ? reject(new ErroRemoto('O RabbitMQ não confirmou a publicação', 503)) : resolve());
    });
  }

  /**
   * Consome uma fila de eventos com ack manual. Uma exceção devolve a mensagem para a fila uma vez;
   * se falhar de novo, ela segue para `<fila>.falhas` para análise.
   */
  consumir(fila: string, tratar: (conteudo: unknown, msg: ConsumeMessage) => Promise<void>): void {
    this.registrar(async canal => {
      await canal.consume(fila, msg => {
        if (!msg) return;
        void (async () => {
          try {
            await tratar(JSON.parse(msg.content.toString('utf8')), msg);
            canal.ack(msg);
          } catch (erro) {
            const reenviar = !msg.fields.redelivered;
            this.log.error({ err: erro, fila, messageId: msg.properties.messageId, reenviar }, 'Falha ao processar mensagem');
            canal.nack(msg, false, reenviar);
          }
        })().catch(() => undefined);
      }, { noAck: false });
    });
  }

  /** Atende consultas RPC: processa o pedido e publica a resposta na fila indicada em `replyTo`. */
  responder(fila: string, tratar: (pedido: unknown) => Promise<unknown>): void {
    this.registrar(async canal => {
      await canal.consume(fila, msg => {
        if (!msg) return;
        void (async () => {
          let resposta: RespostaRpc;
          try { resposta = { ok: true, dados: await tratar(JSON.parse(msg.content.toString('utf8'))) }; }
          catch (erro) {
            const status = typeof (erro as { status?: unknown }).status === 'number' ? (erro as { status: number }).status : 500;
            if (status >= 500) this.log.error({ err: erro, fila }, 'Falha ao atender consulta');
            resposta = { ok: false, erro: { mensagem: status >= 500 ? 'Falha ao atender a consulta' : (erro as Error).message, status } };
          }
          try {
            if (msg.properties.replyTo) {
              await new Promise<void>((resolve, reject) => canal.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(resposta)), {
                correlationId: msg.properties.correlationId, contentType: 'application/json', appId: this.servico,
              }, erro => erro ? reject(erro) : resolve()));
            }
            canal.ack(msg);
          } catch (erro) {
            this.log.error({ err: erro, fila }, 'Falha ao enviar resposta');
            canal.nack(msg, false, false);
          }
        })().catch(() => undefined);
      }, { noAck: false });
    });
  }

  /**
   * Consulta RPC: publica o pedido na fila durável e aguarda a resposta na fila de retorno desta
   * instância, associada pelo correlationId. O pedido expira junto com o prazo, para que um
   * serviço que volte depois não processe consultas que ninguém mais espera.
   */
  async consultar<T>(fila: string, pedido: unknown, timeoutMs = 3_000): Promise<T> {
    if (!this.fazConsultas) throw new Error('Mensageria criada sem a opção consultas');
    const canal = this.exigirCanal();
    const filaRetorno = this.filaRetorno!;
    const correlationId = randomUUID();
    const resposta = new Promise<unknown>((resolver, rejeitar) => {
      const timer = setTimeout(() => {
        this.pendentes.delete(correlationId);
        rejeitar(new ErroRemoto(`Sem resposta da fila ${fila} em ${timeoutMs} ms`, 504));
      }, timeoutMs);
      this.pendentes.set(correlationId, { resolver, rejeitar, timer });
    });
    canal.sendToQueue(fila, Buffer.from(JSON.stringify(pedido)), {
      correlationId, replyTo: filaRetorno, expiration: String(timeoutMs), contentType: 'application/json',
      persistent: false, appId: this.servico, messageId: correlationId,
    }, erro => {
      if (!erro) return;
      const pendente = this.pendentes.get(correlationId);
      if (pendente) { clearTimeout(pendente.timer); this.pendentes.delete(correlationId); pendente.rejeitar(new ErroRemoto('O RabbitMQ recusou a consulta', 503)); }
    });
    return resposta as Promise<T>;
  }

  private receberResposta(msg: ConsumeMessage | null): void {
    if (!msg) return;
    const pendente = this.pendentes.get(msg.properties.correlationId);
    if (!pendente) return;
    clearTimeout(pendente.timer); this.pendentes.delete(msg.properties.correlationId);
    try {
      const resposta = JSON.parse(msg.content.toString('utf8')) as RespostaRpc;
      if (resposta.ok) pendente.resolver(resposta.dados);
      else pendente.rejeitar(new ErroRemoto(resposta.erro?.mensagem ?? 'Erro remoto', resposta.erro?.status ?? 502));
    } catch { pendente.rejeitar(new ErroRemoto('Resposta inválida', 502)); }
  }

  /** Tarefas são refeitas a cada reconexão (consumidores pertencem ao canal). */
  private registrar(tarefa: Tarefa): void {
    this.tarefas.push(tarefa);
    if (this.canal) void tarefa(this.canal).catch(erro => this.log.error({ err: erro }, 'Falha ao registrar consumidor'));
  }

  async fechar(): Promise<void> {
    this.encerrando = true;
    clearTimeout(this.religar);
    for (const pendente of this.pendentes.values()) { clearTimeout(pendente.timer); pendente.rejeitar(new ErroRemoto('Mensageria encerrada', 503)); }
    this.pendentes.clear();
    const conexao = this.conexao;
    this.canal = undefined; this.conexao = undefined;
    await conexao?.close().catch(() => undefined);
  }
}

/** Contrato mínimo usado pelas rotas e pelos testes (permite um dublê em memória). */
export type PortaMensageria = Pick<Mensageria, 'conectada' | 'publicar' | 'consultar'>;
