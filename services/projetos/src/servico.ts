import { randomUUID } from 'node:crypto';
import { ErroDominio, STATUS, aplicarEventoRecomendacao, eventoProjeto, metricasIniciais, validarEventoRecomendacao } from './dominio.ts';
import type { EventoProjeto, Projeto, RepositorioProjetos, StatusProjeto } from './dominio.ts';
import { FILAS } from './mensageria.ts';
import type { PortaMensageria } from './mensageria.ts';

export interface NovoProjeto { titulo: string; tipoProjeto?: string; dados?: Record<string, unknown> }
export interface AlteracaoProjeto { titulo?: string; dados?: Record<string, unknown> }

/** Casos de uso do serviço de projetos. Toda mudança de estado gera um evento em `eventos-projetos`. */
export class ServicoProjetos {
  private repositorio: RepositorioProjetos;
  private mensageria: Pick<PortaMensageria, 'publicar'>;
  constructor(repositorio: RepositorioProjetos, mensageria: Pick<PortaMensageria, 'publicar'>) {
    this.repositorio = repositorio; this.mensageria = mensageria;
  }

  private publicar(evento: EventoProjeto): Promise<void> {
    return this.mensageria.publicar(FILAS.eventosProjetos, evento, { messageId: evento.id, type: evento.tipo });
  }

  async listar(status?: StatusProjeto): Promise<Projeto[]> { return this.repositorio.listar(status ? { status } : {}); }

  async buscar(id: string): Promise<Projeto> {
    const projeto = await this.repositorio.buscar(id);
    if (!projeto) throw new ErroDominio('Projeto não encontrado', 404);
    return projeto;
  }

  /** Cadastro manual (sem recomendação): o projeto nasce CRIADO. */
  async criar(entrada: NovoProjeto): Promise<Projeto> {
    const agora = new Date().toISOString();
    const projeto: Projeto = {
      id: randomUUID(), titulo: entrada.titulo, tipoProjeto: entrada.tipoProjeto ?? 'padrao', status: 'CRIADO', origem: 'manual',
      dados: entrada.dados ?? {}, metricas: metricasIniciais(), resultados: [{ evento: 'cadastro', ocorridoEm: agora, resumo: 'Projeto cadastrado' }],
      versao: 1, criadoEm: agora, atualizadoEm: agora, finalizadoEm: null,
    };
    await this.repositorio.criar(projeto, () => this.publicar(eventoProjeto(projeto, 'projeto.criado', 'cadastro', randomUUID(), 'cinebridge-projetos', [], {}, agora)));
    return projeto;
  }

  async atualizar(id: string, alteracao: AlteracaoProjeto): Promise<Projeto> {
    return this.repositorio.alterar(id, atual => {
      if (atual.status === 'FINALIZADO') throw new ErroDominio('Projeto finalizado não pode ser alterado', 409);
      const agora = new Date().toISOString();
      return { ...atual, titulo: alteracao.titulo ?? atual.titulo, dados: { ...atual.dados, ...alteracao.dados },
        resultados: [...atual.resultados, { evento: 'edicao', ocorridoEm: agora, resumo: 'Configuração alterada' }].slice(-100),
        versao: atual.versao + 1, atualizadoEm: agora };
    }, novo => this.publicar(eventoProjeto(novo, 'projeto.atualizado', 'edicao', randomUUID(), 'cinebridge-projetos', [], { campos: Object.keys(alteracao) })));
  }

  async finalizar(id: string, resumo?: string): Promise<Projeto> {
    return this.repositorio.alterar(id, atual => {
      if (atual.status === 'FINALIZADO') throw new ErroDominio('Projeto já finalizado', 409);
      const agora = new Date().toISOString();
      return { ...atual, status: 'FINALIZADO', finalizadoEm: agora, versao: atual.versao + 1, atualizadoEm: agora,
        resultados: [...atual.resultados, { evento: 'finalizacao', ocorridoEm: agora, resumo: resumo ?? 'Projeto finalizado' }].slice(-100) };
    }, novo => this.publicar(eventoProjeto(novo, 'projeto.finalizado', 'finalizacao', randomUUID(), 'cinebridge-projetos', [], resumo ? { resumo } : {})));
  }

  /**
   * Consumidor de `eventos-recomendacoes`. Aplica o evento uma única vez e publica o evento de
   * ciclo de vida. Se a publicação falhar, a mensagem volta para a fila; na reentrega o projeto não
   * é alterado de novo, apenas a mesma publicação é reenviada (o id é estável).
   */
  async processarEventoRecomendacao(conteudo: unknown): Promise<EventoProjeto> {
    const evento = validarEventoRecomendacao(conteudo);
    const publicacao = await this.repositorio.aplicarUmaVez(evento, atual => aplicarEventoRecomendacao(atual, evento));
    await this.publicar(publicacao);
    return publicacao;
  }

  /** Consumidor RPC de `consulta-projetos`. */
  async atenderConsulta(pedido: unknown): Promise<Projeto | Projeto[]> {
    const p = typeof pedido === 'object' && pedido !== null ? pedido as Record<string, unknown> : {};
    if (p.operacao === 'buscar' && typeof p.id === 'string') return this.buscar(p.id);
    if (p.operacao === 'listar') {
      if (p.status !== undefined && !STATUS.includes(p.status as StatusProjeto)) throw new ErroDominio('Status inválido', 400);
      return this.listar(p.status as StatusProjeto | undefined);
    }
    throw new ErroDominio('Pedido inválido', 400);
  }
}
