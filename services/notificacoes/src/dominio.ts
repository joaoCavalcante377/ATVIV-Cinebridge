import { createHash } from 'node:crypto';

/** Evento recebido da fila `eventos-projetos` (publicado pelo serviço de projetos). */
export interface EventoProjeto {
  id: string; tipo: 'projeto.criado' | 'projeto.atualizado' | 'projeto.finalizado'; projetoId: string; ocorridoEm: string;
  motivo: string; origem: string; titulo: string; status: string; destinatarios: string[];
  metricas: Record<string, unknown>; detalhes: Record<string, unknown>;
}
export type Canal = 'email' | 'interno';
export interface Notificacao {
  id: string; eventoId: string; projetoId: string; tipoEvento: string; motivo: string; canal: Canal;
  destinatario: string; assunto: string; mensagem: string; dados: Record<string, unknown>; criadaEm: string;
}

export class ErroDominio extends Error {
  status: number;
  constructor(message: string, status = 422) { super(message); this.name = 'ErroDominio'; this.status = status; }
}

const objeto = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const TIPOS = ['projeto.criado', 'projeto.atualizado', 'projeto.finalizado'];

export function validarEvento(valor: unknown): EventoProjeto {
  const e = objeto(valor);
  if (typeof e.id !== 'string' || !TIPOS.includes(e.tipo as string) || typeof e.projetoId !== 'string' || typeof e.ocorridoEm !== 'string') {
    throw new ErroDominio('Evento de projeto inválido', 400);
  }
  const destinatarios = Array.isArray(e.destinatarios) ? e.destinatarios.filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
  return {
    id: e.id, tipo: e.tipo as EventoProjeto['tipo'], projetoId: e.projetoId, ocorridoEm: e.ocorridoEm,
    motivo: typeof e.motivo === 'string' ? e.motivo : e.tipo as string, origem: typeof e.origem === 'string' ? e.origem : 'desconhecida',
    titulo: typeof e.titulo === 'string' ? e.titulo : 'Projeto', status: typeof e.status === 'string' ? e.status : '',
    destinatarios: destinatarios.length ? [...new Set(destinatarios)] : [`produtor:${e.projetoId}`],
    metricas: objeto(e.metricas), detalhes: objeto(e.detalhes),
  };
}

const real = (centavos: unknown): string => typeof centavos === 'number'
  ? (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';

/** Texto da notificação conforme o evento e quem a recebe (produtor ou profissional). */
export function compor(evento: EventoProjeto, destinatario: string): { assunto: string; mensagem: string } {
  const projeto = `"${evento.titulo}"`;
  const profissional = destinatario.startsWith('profissional:');
  const d = evento.detalhes, m = evento.metricas;
  switch (evento.motivo) {
    case 'recomendacao.gerada':
      if (evento.tipo === 'projeto.criado') {
        return profissional
          ? { assunto: `Você foi sugerido para ${projeto}`, mensagem: `O recomendador indicou seu perfil para o projeto ${projeto}. Aguarde o convite do produtor.` }
          : { assunto: `Projeto ${projeto} criado`, mensagem: `A equipe recomendada tem ${String(m.integrantes ?? 0)} integrante(s), custo de ${real(m.custoEquipeCentavos)} e situação ${String(m.equipeStatus ?? '—')}.` };
      }
      return { assunto: `Nova recomendação em ${projeto}`, mensagem: d.papel ? `Há uma nova sugestão para o papel ${String(d.papel)}.` : 'A equipe foi recalculada.' };
    case 'convite.criado':
      return profissional
        ? { assunto: `Convite para ${projeto}`, mensagem: `Você foi convidado para atuar como ${String(d.papel)} em ${projeto}. Responda o convite pela plataforma.` }
        : { assunto: `Convite emitido em ${projeto}`, mensagem: `Convite enviado para o papel ${String(d.papel)}.` };
    case 'convite.respondido':
      return { assunto: `Convite ${d.resposta === 'ACEITO' ? 'aceito' : 'recusado'} em ${projeto}`,
        mensagem: d.resposta === 'ACEITO' ? 'O profissional aceitou o convite.' : 'O profissional recusou o convite; uma nova sugestão foi gerada para o papel.' };
    case 'membro.substituido': return { assunto: `Integrante substituído em ${projeto}`, mensagem: `O papel ${String(d.papel)} recebeu uma nova sugestão.` };
    case 'convites.cancelados': return { assunto: `Convite cancelado em ${projeto}`, mensagem: 'O convite deixou de valer porque a equipe foi alterada.' };
    case 'equipe.confirmada': return { assunto: `Equipe confirmada em ${projeto}`, mensagem: 'Todos os integrantes aceitaram. A equipe está confirmada.' };
    case 'equipe.reaberta': return { assunto: `Equipe reaberta em ${projeto}`, mensagem: 'A equipe confirmada foi alterada e precisa de novos aceites.' };
    case 'projeto.reavaliado': return { assunto: `Critérios alterados em ${projeto}`, mensagem: 'Os critérios do projeto mudaram e a equipe foi recalculada.' };
    case 'pagamentos.processados':
      return { assunto: `Projeto ${projeto} finalizado`, mensagem: profissional ? 'O pagamento da sua participação foi processado.' : `Pagamentos processados: ${real(m.pagamentosCentavos)}.` };
    case 'cadastro': return { assunto: `Projeto ${projeto} cadastrado`, mensagem: 'O projeto foi registrado.' };
    case 'edicao': return { assunto: `Projeto ${projeto} atualizado`, mensagem: 'A configuração do projeto foi alterada.' };
    case 'finalizacao': return { assunto: `Projeto ${projeto} finalizado`, mensagem: typeof d.resumo === 'string' ? d.resumo : 'O projeto foi encerrado.' };
    default: return { assunto: `Atualização em ${projeto}`, mensagem: `Evento ${evento.motivo}; situação ${evento.status}.` };
  }
}

/** Identificador determinístico: reprocessar o mesmo evento não duplica notificações. */
export function idNotificacao(eventoId: string, canal: Canal, destinatario: string): string {
  return createHash('sha256').update(JSON.stringify([eventoId, canal, destinatario])).digest('hex');
}

export function criarNotificacao(evento: EventoProjeto, canal: Canal, destinatario: string): Notificacao {
  return {
    id: idNotificacao(evento.id, canal, destinatario), eventoId: evento.id, projetoId: evento.projetoId, tipoEvento: evento.tipo,
    motivo: evento.motivo, canal, destinatario, ...compor(evento, destinatario),
    dados: { status: evento.status, detalhes: evento.detalhes, metricas: evento.metricas }, criadaEm: evento.ocorridoEm,
  };
}

export interface FiltroNotificacoes { projetoId?: string; destinatario?: string; canal?: Canal; limite?: number }
export interface RepositorioNotificacoes {
  /** Grava se ainda não existir (idempotente). Retorna true quando a notificação é nova. */
  salvar(notificacao: Notificacao): Promise<boolean>;
  listar(filtro: FiltroNotificacoes): Promise<Notificacao[]>;
  buscar(id: string): Promise<Notificacao | null>;
  verificar(): Promise<void>;
}
