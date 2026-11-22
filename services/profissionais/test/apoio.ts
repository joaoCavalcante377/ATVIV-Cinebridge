import { ErroDominio } from '../src/dominio.ts';
import type { Avaliacao, Profissional, RepositorioProfissionais } from '../src/dominio.ts';

export class RepositorioMemoria implements RepositorioProfissionais {
  dados = new Map<string, Profissional>();
  offline = false;
  async listar(): Promise<Profissional[]> { return structuredClone([...this.dados.values()]); }
  async buscar(id: string): Promise<Profissional | null> { return structuredClone(this.dados.get(id) ?? null); }
  async salvar(p: Profissional): Promise<void> { this.dados.set(p.id, structuredClone(p)); }
  async avaliar(id: string, a: Avaliacao): Promise<Profissional> {
    const p = this.dados.get(id);
    if (!p) throw new ErroDominio('Profissional não encontrado', 404);
    p.avaliacoes.push({ ...a });
    return structuredClone(p);
  }
  async verificar(): Promise<void> { if (this.offline) throw new Error('offline'); }
}

export function profissional(id: string, alteracoes: Partial<Profissional> = {}): Profissional {
  return {
    id, nome: `Pessoa ${id}`, email: `${id}@example.com`, papeis: ['EDITOR'], competencias: [{ nome: 'montagem', nivel: 4 }],
    precoCentavos: 50_000, disponibilidade: { inicio: '2027-01-01', fim: '2027-12-31' }, localizacao: 'São Paulo',
    historico: [], avaliacoes: [], ...alteracoes,
  };
}
