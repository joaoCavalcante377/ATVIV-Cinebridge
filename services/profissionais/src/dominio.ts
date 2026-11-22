/** Modelo do cadastro de profissionais. Os nomes seguem o contrato usado pelo recomendador. */
export const PAPEIS = ['DIRETOR', 'DIRETOR_FOTOGRAFIA', 'SONOPLASTA', 'EDITOR', 'ROTEIRISTA', 'EFEITOS_VISUAIS'] as const;
export type Papel = typeof PAPEIS[number];
export type TipoCaptacao = 'documentario' | 'ficcao' | 'animacao';
export interface Competencia { nome: string; nivel: number }
export interface Avaliacao { nota: number; comentario: string; data: string }
export interface Historico { genero: string; tipoCaptacao: TipoCaptacao; papel: Papel; projetoId?: string; nota?: number }
export interface Profissional {
  id: string; nome: string; email: string; papeis: Papel[]; competencias: Competencia[];
  precoCentavos: number; disponibilidade: { inicio: string; fim: string }; localizacao: string;
  historico: Historico[]; avaliacoes: Avaliacao[];
}
export interface Criterios { papeis?: Papel[]; localizacao?: string; periodo?: { inicio: string; fim: string }; limite?: number }

export class ErroDominio extends Error {
  status: number;
  constructor(message: string, status = 422) { super(message); this.name = 'ErroDominio'; this.status = status; }
}

export const normalizarTexto = (valor: string): string => valor.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function dataValida(valor: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) && Number.isFinite(Date.parse(valor)) && new Date(valor).toISOString().slice(0, 10) === valor;
}
const nivelValido = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 5;
const texto = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** Mesmas regras de consistência do ValidadorConsistencia do recomendador (ATVII). */
export function validarProfissional(p: Profissional): string[] {
  const erros: string[] = [];
  if (![p.id, p.nome, p.email, p.localizacao].every(texto) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) erros.push('Identificação, email ou localização inválidos.');
  if (!Number.isSafeInteger(p.precoCentavos) || p.precoCentavos < 0) erros.push('Preço deve ser inteiro não negativo em centavos.');
  if (p.papeis.length === 0 || p.papeis.some(r => !PAPEIS.includes(r)) || new Set(p.papeis).size !== p.papeis.length) erros.push('Papéis do profissional inválidos.');
  const nomes = p.competencias.map(c => normalizarTexto(c.nome));
  if (p.competencias.some(c => !texto(c.nome) || !nivelValido(c.nivel)) || new Set(nomes).size !== nomes.length) erros.push('Competências inválidas ou repetidas.');
  if (!dataValida(p.disponibilidade.inicio) || !dataValida(p.disponibilidade.fim) || p.disponibilidade.inicio > p.disponibilidade.fim) erros.push('Disponibilidade inválida.');
  if (p.avaliacoes.some(a => !nivelValido(a.nota) || !dataValida(a.data))) erros.push('Avaliação inválida.');
  if (p.historico.some(h => !texto(h.genero) || !PAPEIS.includes(h.papel) || !['documentario', 'ficcao', 'animacao'].includes(h.tipoCaptacao)
    || (h.nota !== undefined && !nivelValido(h.nota)) || (h.projetoId !== undefined && !texto(h.projetoId)))) erros.push('Histórico inválido.');
  return erros;
}

export function validarAvaliacao(a: Avaliacao): void {
  if (!nivelValido(a?.nota)) throw new ErroDominio('A nota deve estar entre 0 e 5.');
  if (typeof a.comentario !== 'string' || typeof a.data !== 'string' || !dataValida(a.data)) {
    throw new ErroDominio('Avaliação exige comentário e data no formato AAAA-MM-DD.');
  }
}

/** Filtro por papel, localização (ou remoto) e disponibilidade no período inteiro. */
export function filtrar(profissionais: Profissional[], criterios: Criterios = {}): Profissional[] {
  const local = criterios.localizacao ? normalizarTexto(criterios.localizacao) : undefined;
  const filtrados = profissionais.filter(p =>
    (!criterios.papeis?.length || p.papeis.some(papel => criterios.papeis!.includes(papel)))
    && (!local || local === 'remoto' || [local, 'remoto'].includes(normalizarTexto(p.localizacao)))
    && (!criterios.periodo || (p.disponibilidade.inicio <= criterios.periodo.inicio && p.disponibilidade.fim >= criterios.periodo.fim)));
  return criterios.limite ? filtrados.slice(0, criterios.limite) : filtrados;
}

/** Porta de persistência; PostgreSQL em produção e memória nos testes. */
export interface RepositorioProfissionais {
  listar(): Promise<Profissional[]>;
  buscar(id: string): Promise<Profissional | null>;
  salvar(profissional: Profissional): Promise<void>;
  /** Acrescenta a avaliação de forma atômica (sem perder avaliações concorrentes). */
  avaliar(id: string, avaliacao: Avaliacao): Promise<Profissional>;
  verificar(): Promise<void>;
}
