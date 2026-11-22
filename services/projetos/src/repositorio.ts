import pg from 'pg';
import { ErroDominio } from './dominio.ts';
import type { EventoProjeto, EventoRecomendacao, Projeto, RepositorioProjetos, StatusProjeto } from './dominio.ts';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS projetos (
  id text PRIMARY KEY, titulo text NOT NULL, tipo_projeto text NOT NULL,
  status text NOT NULL CHECK (status IN ('CRIADO', 'EM_ANDAMENTO', 'EQUIPE_CONFIRMADA', 'FINALIZADO')),
  origem text NOT NULL CHECK (origem IN ('cinebridge-api', 'manual')),
  dados jsonb NOT NULL, metricas jsonb NOT NULL, resultados jsonb NOT NULL, versao integer NOT NULL CHECK (versao > 0),
  criado_em timestamptz NOT NULL, atualizado_em timestamptz NOT NULL, finalizado_em timestamptz);
CREATE INDEX IF NOT EXISTS projetos_status ON projetos (status);
CREATE TABLE IF NOT EXISTS eventos_processados (
  id text PRIMARY KEY, projeto_id text NOT NULL, tipo text NOT NULL, publicacao jsonb NOT NULL,
  processado_em timestamptz NOT NULL DEFAULT now());`;

interface Linha {
  id: string; titulo: string; tipo_projeto: string; status: StatusProjeto; origem: Projeto['origem'];
  dados: Projeto['dados']; metricas: Projeto['metricas']; resultados: Projeto['resultados']; versao: number;
  criado_em: Date; atualizado_em: Date; finalizado_em: Date | null;
}
const paraProjeto = (l: Linha): Projeto => ({
  id: l.id, titulo: l.titulo, tipoProjeto: l.tipo_projeto, status: l.status, origem: l.origem, dados: l.dados,
  metricas: l.metricas, resultados: l.resultados, versao: l.versao, criadoEm: l.criado_em.toISOString(),
  atualizadoEm: l.atualizado_em.toISOString(), finalizadoEm: l.finalizado_em?.toISOString() ?? null,
});

export class RepositorioPostgres implements RepositorioProjetos {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }

  async migrar(): Promise<void> {
    const cliente = await this.pool.connect();
    try { await cliente.query('SELECT pg_advisory_lock(4002)'); await cliente.query(ESQUEMA); }
    finally { await cliente.query('SELECT pg_advisory_unlock(4002)').catch(() => undefined); cliente.release(); }
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

  private async gravar(cliente: pg.PoolClient, p: Projeto): Promise<void> {
    await cliente.query(`INSERT INTO projetos (id, titulo, tipo_projeto, status, origem, dados, metricas, resultados, versao, criado_em, atualizado_em, finalizado_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET titulo = EXCLUDED.titulo, tipo_projeto = EXCLUDED.tipo_projeto, status = EXCLUDED.status,
        dados = EXCLUDED.dados, metricas = EXCLUDED.metricas, resultados = EXCLUDED.resultados, versao = EXCLUDED.versao,
        atualizado_em = EXCLUDED.atualizado_em, finalizado_em = EXCLUDED.finalizado_em`,
    [p.id, p.titulo, p.tipoProjeto, p.status, p.origem, JSON.stringify(p.dados), JSON.stringify(p.metricas),
      JSON.stringify(p.resultados), p.versao, p.criadoEm, p.atualizadoEm, p.finalizadoEm]);
  }

  async listar(filtro: { status?: StatusProjeto } = {}): Promise<Projeto[]> {
    const { rows } = filtro.status
      ? await this.pool.query<Linha>('SELECT * FROM projetos WHERE status = $1 ORDER BY criado_em DESC, id', [filtro.status])
      : await this.pool.query<Linha>('SELECT * FROM projetos ORDER BY criado_em DESC, id');
    return rows.map(paraProjeto);
  }

  async buscar(id: string): Promise<Projeto | null> {
    const { rows } = await this.pool.query<Linha>('SELECT * FROM projetos WHERE id = $1', [id]);
    return rows[0] ? paraProjeto(rows[0]) : null;
  }

  async criar(projeto: Projeto, aposGravar: () => Promise<void>): Promise<void> {
    await this.transacao(async cliente => {
      const existe = await cliente.query('SELECT 1 FROM projetos WHERE id = $1', [projeto.id]);
      if (existe.rowCount) throw new ErroDominio('Projeto já existe', 409);
      await this.gravar(cliente, projeto);
      // Publica antes do commit: se o RabbitMQ não confirmar, nada é gravado.
      await aposGravar();
    });
  }

  async alterar(id: string, mudar: (atual: Projeto) => Projeto, aposGravar: (novo: Projeto) => Promise<void>): Promise<Projeto> {
    return this.transacao(async cliente => {
      const { rows } = await cliente.query<Linha>('SELECT * FROM projetos WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw new ErroDominio('Projeto não encontrado', 404);
      const novo = mudar(paraProjeto(rows[0]));
      await this.gravar(cliente, novo);
      await aposGravar(novo);
      return novo;
    });
  }

  async aplicarUmaVez(evento: EventoRecomendacao, aplicar: (atual: Projeto | null) => { projeto: Projeto; publicar: EventoProjeto }): Promise<EventoProjeto> {
    return this.transacao(async cliente => {
      // Serializa os eventos do mesmo projeto, inclusive quando o projeto ainda não existe.
      await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))', [evento.projetoId]);
      const anterior = await cliente.query<{ publicacao: EventoProjeto }>('SELECT publicacao FROM eventos_processados WHERE id = $1', [evento.id]);
      if (anterior.rows[0]) return anterior.rows[0].publicacao;
      const { rows } = await cliente.query<Linha>('SELECT * FROM projetos WHERE id = $1', [evento.projetoId]);
      const { projeto, publicar } = aplicar(rows[0] ? paraProjeto(rows[0]) : null);
      await this.gravar(cliente, projeto);
      await cliente.query('INSERT INTO eventos_processados (id, projeto_id, tipo, publicacao) VALUES ($1, $2, $3, $4)',
        [evento.id, evento.projetoId, evento.tipo, JSON.stringify(publicar)]);
      return publicar;
    });
  }

  async verificar(): Promise<void> { await this.pool.query('SELECT 1'); }
}
