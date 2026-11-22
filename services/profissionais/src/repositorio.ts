import pg from 'pg';
import { ErroDominio, validarProfissional } from './dominio.ts';
import type { Avaliacao, Profissional, RepositorioProfissionais } from './dominio.ts';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS profissionais (
  id text PRIMARY KEY, nome text NOT NULL, email text NOT NULL, papeis jsonb NOT NULL,
  preco_centavos bigint NOT NULL CHECK (preco_centavos BETWEEN 0 AND 9007199254740991),
  disponibilidade jsonb NOT NULL, localizacao text NOT NULL, historico jsonb NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS competencias (
  profissional_id text NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE, posicao integer NOT NULL,
  nome text NOT NULL, nivel double precision NOT NULL CHECK (nivel BETWEEN 0 AND 5),
  PRIMARY KEY (profissional_id, posicao));
CREATE TABLE IF NOT EXISTS avaliacoes (
  id bigserial PRIMARY KEY, profissional_id text NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  nota double precision NOT NULL CHECK (nota BETWEEN 0 AND 5), comentario text NOT NULL, data text NOT NULL);
CREATE INDEX IF NOT EXISTS avaliacoes_profissional ON avaliacoes (profissional_id);`;

interface Linha {
  id: string; nome: string; email: string; papeis: Profissional['papeis']; preco_centavos: string;
  disponibilidade: Profissional['disponibilidade']; localizacao: string; historico: Profissional['historico'];
}

export class RepositorioPostgres implements RepositorioProfissionais {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }

  /** Cria as tabelas, se ainda não existirem. Um lock consultivo evita corrida entre réplicas. */
  async migrar(): Promise<void> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('SELECT pg_advisory_lock(4001)');
      await cliente.query(ESQUEMA);
    } finally {
      await cliente.query('SELECT pg_advisory_unlock(4001)').catch(() => undefined);
      cliente.release();
    }
  }

  private async montar(cliente: pg.Pool | pg.PoolClient, linhas: Linha[]): Promise<Profissional[]> {
    if (!linhas.length) return [];
    const ids = linhas.map(l => l.id);
    const competencias = await cliente.query<{ profissional_id: string; nome: string; nivel: number }>(
      'SELECT profissional_id, nome, nivel FROM competencias WHERE profissional_id = ANY($1) ORDER BY profissional_id, posicao', [ids]);
    const avaliacoes = await cliente.query<{ profissional_id: string; nota: number; comentario: string; data: string }>(
      'SELECT profissional_id, nota, comentario, data FROM avaliacoes WHERE profissional_id = ANY($1) ORDER BY id', [ids]);
    const mapa = new Map<string, Profissional>(linhas.map(l => [l.id, {
      id: l.id, nome: l.nome, email: l.email, papeis: l.papeis, competencias: [], precoCentavos: Number(l.preco_centavos),
      disponibilidade: l.disponibilidade, localizacao: l.localizacao, historico: l.historico, avaliacoes: [],
    }]));
    for (const c of competencias.rows) mapa.get(c.profissional_id)?.competencias.push({ nome: c.nome, nivel: c.nivel });
    for (const a of avaliacoes.rows) mapa.get(a.profissional_id)?.avaliacoes.push({ nota: a.nota, comentario: a.comentario, data: a.data });
    return [...mapa.values()];
  }

  async listar(): Promise<Profissional[]> {
    const { rows } = await this.pool.query<Linha>('SELECT * FROM profissionais ORDER BY id');
    return this.montar(this.pool, rows);
  }

  async buscar(id: string): Promise<Profissional | null> {
    const { rows } = await this.pool.query<Linha>('SELECT * FROM profissionais WHERE id = $1', [id]);
    return (await this.montar(this.pool, rows))[0] ?? null;
  }

  private async gravar(cliente: pg.PoolClient, p: Profissional): Promise<void> {
    await cliente.query(`INSERT INTO profissionais (id, nome, email, papeis, preco_centavos, disponibilidade, localizacao, historico)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, email = EXCLUDED.email, papeis = EXCLUDED.papeis,
        preco_centavos = EXCLUDED.preco_centavos, disponibilidade = EXCLUDED.disponibilidade,
        localizacao = EXCLUDED.localizacao, historico = EXCLUDED.historico, atualizado_em = now()`,
    [p.id, p.nome, p.email, JSON.stringify(p.papeis), p.precoCentavos, JSON.stringify(p.disponibilidade), p.localizacao, JSON.stringify(p.historico)]);
    await cliente.query('DELETE FROM competencias WHERE profissional_id = $1', [p.id]);
    await cliente.query('DELETE FROM avaliacoes WHERE profissional_id = $1', [p.id]);
    for (const [i, c] of p.competencias.entries()) {
      await cliente.query('INSERT INTO competencias (profissional_id, posicao, nome, nivel) VALUES ($1, $2, $3, $4)', [p.id, i, c.nome, c.nivel]);
    }
    for (const a of p.avaliacoes) {
      await cliente.query('INSERT INTO avaliacoes (profissional_id, nota, comentario, data) VALUES ($1, $2, $3, $4)', [p.id, a.nota, a.comentario, a.data]);
    }
  }

  private async transacao<T>(executar: (cliente: pg.PoolClient) => Promise<T>): Promise<T> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');
      const resultado = await executar(cliente);
      await cliente.query('COMMIT');
      return resultado;
    } catch (erro) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw erro;
    } finally { cliente.release(); }
  }

  async salvar(profissional: Profissional): Promise<void> {
    await this.transacao(cliente => this.gravar(cliente, profissional));
  }

  async avaliar(id: string, avaliacao: Avaliacao): Promise<Profissional> {
    return this.transacao(async cliente => {
      // FOR UPDATE serializa avaliações concorrentes do mesmo profissional.
      const { rows } = await cliente.query<Linha>('SELECT * FROM profissionais WHERE id = $1 FOR UPDATE', [id]);
      const atual = (await this.montar(cliente, rows))[0];
      if (!atual) throw new ErroDominio('Profissional não encontrado', 404);
      const novo = { ...atual, avaliacoes: [...atual.avaliacoes, { nota: avaliacao.nota, comentario: avaliacao.comentario, data: avaliacao.data }] };
      const erros = validarProfissional(novo);
      if (erros.length) throw new ErroDominio(erros.join(' '));
      await cliente.query('INSERT INTO avaliacoes (profissional_id, nota, comentario, data) VALUES ($1, $2, $3, $4)', [id, avaliacao.nota, avaliacao.comentario, avaliacao.data]);
      await cliente.query('UPDATE profissionais SET atualizado_em = now() WHERE id = $1', [id]);
      return novo;
    });
  }

  async verificar(): Promise<void> { await this.pool.query('SELECT 1'); }
}
