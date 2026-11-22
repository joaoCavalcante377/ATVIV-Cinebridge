/**
 * Ciclo de vida dos projetos audiovisuais. O serviço de projetos é a fonte de verdade sobre o estado
 * de cada projeto, suas métricas e resultados; o recomendador informa o que aconteceu por eventos.
 */
export const STATUS = ['CRIADO', 'EM_ANDAMENTO', 'EQUIPE_CONFIRMADA', 'FINALIZADO'] as const;
export type StatusProjeto = typeof STATUS[number];
export type TipoEventoProjeto = 'projeto.criado' | 'projeto.atualizado' | 'projeto.finalizado';

export interface Metricas {
  recomendacoes: number;
  convitesEmitidos: number;
  convitesAceitos: number;
  convitesRecusados: number;
  substituicoes: number;
  equipeStatus?: string;
  custoEquipeCentavos?: number;
  integrantes?: number;
  papeisPendentes?: string[];
  pagamentosCentavos?: number;
}
export interface Resultado { evento: string; ocorridoEm: string; resumo: string }
export interface Projeto {
  id: string; titulo: string; tipoProjeto: string; status: StatusProjeto; origem: 'cinebridge-api' | 'manual';
  dados: Record<string, unknown>; metricas: Metricas; resultados: Resultado[];
  versao: number; criadoEm: string; atualizadoEm: string; finalizadoEm: string | null;
}

/** Evento publicado pelo recomendador (outbox) na fila `eventos-recomendacoes`. */
export interface EventoRecomendacao {
  id: string; tipo: string; projetoId: string; ocorridoEm: string; dados: Record<string, unknown>;
}
/** Evento publicado na fila `eventos-projetos` e consumido pelas notificações. */
export interface EventoProjeto {
  id: string; tipo: TipoEventoProjeto; projetoId: string; ocorridoEm: string;
  /** O que motivou o evento: tipo do evento do recomendador, `cadastro`, `edicao` ou `finalizacao`. */
  motivo: string; origem: string; titulo: string; status: StatusProjeto;
  destinatarios: string[]; metricas: Metricas; detalhes: Record<string, unknown>;
}

export class ErroDominio extends Error {
  status: number;
  constructor(message: string, status = 422) { super(message); this.name = 'ErroDominio'; this.status = status; }
}

export const metricasIniciais = (): Metricas => ({ recomendacoes: 0, convitesEmitidos: 0, convitesAceitos: 0, convitesRecusados: 0, substituicoes: 0 });
const objeto = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const textos = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
const LIMITE_RESULTADOS = 100;

export function validarEventoRecomendacao(valor: unknown): EventoRecomendacao {
  const e = objeto(valor);
  if (typeof e.id !== 'string' || typeof e.tipo !== 'string' || typeof e.projetoId !== 'string' || typeof e.ocorridoEm !== 'string') {
    throw new ErroDominio('Evento do recomendador inválido', 400);
  }
  return { id: e.id, tipo: e.tipo, projetoId: e.projetoId, ocorridoEm: e.ocorridoEm, dados: objeto(e.dados) };
}

function resumir(evento: EventoRecomendacao): string {
  const d = evento.dados;
  switch (evento.tipo) {
    case 'recomendacao.gerada': return d.papel ? `Nova sugestão para ${String(d.papel)}` : 'Equipe recomendada';
    case 'convite.criado': return `Convite emitido para ${String(d.papel)}`;
    case 'convite.respondido': return `Convite ${String(d.resposta).toLowerCase()} pelo profissional`;
    case 'membro.substituido': return `Integrante de ${String(d.papel)} substituído`;
    case 'convites.cancelados': return 'Convites cancelados';
    case 'equipe.confirmada': return 'Equipe confirmada';
    case 'equipe.reaberta': return 'Equipe reaberta';
    case 'projeto.reavaliado': return 'Critérios reavaliados';
    case 'pagamentos.processados': return 'Pagamentos processados; projeto finalizado';
    default: return evento.tipo;
  }
}

/** Campos do evento de origem que interessam às notificações (sem rankings nem dados volumosos). */
function detalhes(evento: EventoRecomendacao): Record<string, unknown> {
  const d = evento.dados;
  const escolhidos: Record<string, unknown> = {};
  for (const chave of ['papel', 'profissionalId', 'conviteId', 'resposta', 'anterior', 'provedor']) if (d[chave] !== undefined) escolhidos[chave] = d[chave];
  if (Array.isArray(d.pagamentos)) escolhidos.pagamentos = d.pagamentos;
  return escolhidos;
}

/**
 * Aplica um evento do recomendador ao registro do projeto (função pura).
 * Retorna o novo registro e o evento de ciclo de vida a publicar.
 */
export function aplicarEventoRecomendacao(atual: Projeto | null, evento: EventoRecomendacao): { projeto: Projeto; publicar: EventoProjeto } {
  const contexto = objeto(evento.dados.contexto);
  const resumoProjeto = objeto(contexto.projeto);
  const equipe = objeto(contexto.equipe);
  const novo = atual === null;
  const projeto: Projeto = atual ? structuredClone(atual) : {
    id: evento.projetoId, titulo: typeof resumoProjeto.titulo === 'string' ? resumoProjeto.titulo : `Projeto ${evento.projetoId}`,
    tipoProjeto: typeof resumoProjeto.tipoProjeto === 'string' ? resumoProjeto.tipoProjeto : 'padrao',
    status: 'EM_ANDAMENTO', origem: 'cinebridge-api', dados: {}, metricas: metricasIniciais(), resultados: [],
    versao: 0, criadoEm: evento.ocorridoEm, atualizadoEm: evento.ocorridoEm, finalizadoEm: null,
  };
  if (Object.keys(resumoProjeto).length) {
    const { titulo, tipoProjeto, ...configuracao } = resumoProjeto;
    if (typeof titulo === 'string') projeto.titulo = titulo;
    if (typeof tipoProjeto === 'string') projeto.tipoProjeto = tipoProjeto;
    projeto.dados = { ...projeto.dados, ...configuracao };
  }
  const m = projeto.metricas;
  if (typeof equipe.status === 'string') m.equipeStatus = equipe.status;
  if (typeof equipe.custoCentavos === 'number') m.custoEquipeCentavos = equipe.custoCentavos;
  if (typeof equipe.integrantes === 'number') m.integrantes = equipe.integrantes;
  if (Array.isArray(equipe.papeisPendentes)) m.papeisPendentes = textos(equipe.papeisPendentes);

  let tipo: TipoEventoProjeto = novo ? 'projeto.criado' : 'projeto.atualizado';
  switch (evento.tipo) {
    case 'recomendacao.gerada': m.recomendacoes++; break;
    case 'convite.criado': m.convitesEmitidos++; break;
    case 'convite.respondido': if (evento.dados.resposta === 'ACEITO') m.convitesAceitos++; else m.convitesRecusados++; break;
    case 'membro.substituido': m.substituicoes++; break;
    case 'pagamentos.processados': {
      const pagamentos = Array.isArray(evento.dados.pagamentos) ? evento.dados.pagamentos : [];
      m.pagamentosCentavos = pagamentos.reduce((soma: number, p) => soma + (Number(objeto(p).valorCentavos) || 0), 0);
      projeto.status = 'FINALIZADO'; projeto.finalizadoEm = evento.ocorridoEm;
      if (!novo) tipo = 'projeto.finalizado';
      break;
    }
  }
  if (projeto.status !== 'FINALIZADO' || evento.tipo === 'equipe.reaberta') {
    if (evento.tipo === 'equipe.reaberta') projeto.finalizadoEm = null;
    projeto.status = m.equipeStatus === 'CONFIRMADA' ? 'EQUIPE_CONFIRMADA' : 'EM_ANDAMENTO';
  }
  projeto.resultados = [...projeto.resultados, { evento: evento.tipo, ocorridoEm: evento.ocorridoEm, resumo: resumir(evento) }].slice(-LIMITE_RESULTADOS);
  projeto.versao++;
  projeto.atualizadoEm = evento.ocorridoEm;
  return { projeto, publicar: eventoProjeto(projeto, tipo, evento.tipo, `projetos:${evento.id}`, 'cinebridge-api', textos(evento.dados.destinatarios), detalhes(evento), evento.ocorridoEm) };
}

export function eventoProjeto(projeto: Projeto, tipo: TipoEventoProjeto, motivo: string, id: string, origem: string,
  destinatarios: string[], detalhesEvento: Record<string, unknown> = {}, ocorridoEm = new Date().toISOString()): EventoProjeto {
  return {
    id, tipo, projetoId: projeto.id, ocorridoEm, motivo, origem, titulo: projeto.titulo, status: projeto.status,
    destinatarios: destinatarios.length ? [...new Set(destinatarios)] : [`produtor:${projeto.id}`],
    metricas: structuredClone(projeto.metricas), detalhes: detalhesEvento,
  };
}

/** Porta de persistência. `alterar` executa a mudança e a publicação dentro da mesma transação. */
export interface RepositorioProjetos {
  listar(filtro?: { status?: StatusProjeto }): Promise<Projeto[]>;
  buscar(id: string): Promise<Projeto | null>;
  criar(projeto: Projeto, aposGravar: () => Promise<void>): Promise<void>;
  alterar(id: string, mudar: (atual: Projeto) => Projeto, aposGravar: (novo: Projeto) => Promise<void>): Promise<Projeto>;
  /**
   * Aplica um evento externo uma única vez. Se o evento já foi aplicado, devolve a publicação
   * registrada na primeira vez, para que possa ser reenviada sem alterar o projeto de novo.
   */
  aplicarUmaVez(evento: EventoRecomendacao, aplicar: (atual: Projeto | null) => { projeto: Projeto; publicar: EventoProjeto }): Promise<EventoProjeto>;
  verificar(): Promise<void>;
}
