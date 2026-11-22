import { ErroDominio, PAPEIS, filtrar, validarAvaliacao } from './dominio.ts';
import type { Avaliacao, Criterios, Profissional, RepositorioProfissionais } from './dominio.ts';

/**
 * Pedidos aceitos na fila `consulta-profissionais`:
 * - `{ operacao: 'listar', criterios?: { papeis?, localizacao?, periodo?, limite? } }` → Profissional[]
 * - `{ operacao: 'detalhar', id }` → Profissional
 * - `{ operacao: 'avaliar', id, avaliacao: { nota, comentario, data } }` → Profissional atualizado
 */
export type PedidoProfissionais =
  | { operacao: 'listar'; criterios?: Criterios }
  | { operacao: 'detalhar'; id: string }
  | { operacao: 'avaliar'; id: string; avaliacao: Avaliacao };

const objeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function lerCriterios(valor: unknown): Criterios {
  if (valor === undefined) return {};
  if (!objeto(valor)) throw new ErroDominio('Critérios inválidos', 400);
  const criterios: Criterios = {};
  if (valor.papeis !== undefined) {
    if (!Array.isArray(valor.papeis) || valor.papeis.some(p => !PAPEIS.includes(p))) throw new ErroDominio('Papéis inválidos', 400);
    criterios.papeis = valor.papeis;
  }
  if (valor.localizacao !== undefined) {
    if (typeof valor.localizacao !== 'string') throw new ErroDominio('Localização inválida', 400);
    criterios.localizacao = valor.localizacao;
  }
  if (valor.periodo !== undefined) {
    const p = valor.periodo;
    if (!objeto(p) || typeof p.inicio !== 'string' || typeof p.fim !== 'string') throw new ErroDominio('Período inválido', 400);
    criterios.periodo = { inicio: p.inicio, fim: p.fim };
  }
  if (valor.limite !== undefined) {
    if (!Number.isInteger(valor.limite) || (valor.limite as number) < 1) throw new ErroDominio('Limite inválido', 400);
    criterios.limite = valor.limite as number;
  }
  return criterios;
}

export function atenderConsultas(repositorio: RepositorioProfissionais) {
  return async (pedido: unknown): Promise<Profissional | Profissional[]> => {
    if (!objeto(pedido) || typeof pedido.operacao !== 'string') throw new ErroDominio('Pedido inválido', 400);
    switch (pedido.operacao) {
      case 'listar':
        return filtrar(await repositorio.listar(), lerCriterios(pedido.criterios));
      case 'detalhar': {
        if (typeof pedido.id !== 'string') throw new ErroDominio('Informe o id', 400);
        const profissional = await repositorio.buscar(pedido.id);
        if (!profissional) throw new ErroDominio('Profissional não encontrado', 404);
        return profissional;
      }
      case 'avaliar': {
        if (typeof pedido.id !== 'string') throw new ErroDominio('Informe o id', 400);
        validarAvaliacao(pedido.avaliacao as Avaliacao);
        return repositorio.avaliar(pedido.id, pedido.avaliacao as Avaliacao);
      }
      default:
        throw new ErroDominio(`Operação desconhecida: ${pedido.operacao}`, 400);
    }
  };
}
