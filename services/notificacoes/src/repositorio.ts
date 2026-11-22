import pg from 'pg';
import type { FiltroNotificacoes, Notificacao, RepositorioNotificacoes } from './dominio.ts';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS notificacoes (
  id text PRIMARY KEY, evento_id text NOT NULL, projeto_id text NOT NULL, tipo_evento text NOT NULL, motivo text NOT NULL,
  canal text NOT NULL CHECK (canal IN ('email', 'interno')), destinatario text NOT NULL,
  assunto text NOT NULL, mensagem text NOT NULL, dados jsonb NOT NULL,
  criada_em timestamptz NOT NULL, registrada_em timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS notificacoes_projeto ON notificacoes (projeto_id, criada_em);
CREATE INDEX IF NOT EXISTS notificacoes_destinatario ON notificacoes (destinatario, criada_em);`;

interface Linha {
  id: string; evento_id: string; projeto_id: string; tipo_evento: string; motivo: string; canal: Notificacao['canal'];
  destinatario: string; assunto: string; mensagem: string; dados: Notificacao['dados']; criada_em: Date;
}
const paraNotificacao = (l: Linha): Notificacao => ({
  id: l.id, eventoId: l.evento_id, projetoId: l.projeto_id, tipoEvento: l.tipo_evento, motivo: l.motivo, canal: l.canal,
  destinatario: l.destinatario, assunto: l.assunto, mensagem: l.mensagem, dados: l.dados, criadaEm: l.criada_em.toISOString(),
});

export class RepositorioPostgres implements RepositorioNotificacoes {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }

  async migrar(): Promise<void> {
    const cliente = await this.pool.connect();
    try { await cliente.query('SELECT pg_advisory_lock(4003)'); await cliente.query(ESQUEMA); }
    finally { await cliente.query('SELECT pg_advisory_unlock(4003)').catch(() => undefined); cliente.release(); }
  }

  async salvar(n: Notificacao): Promise<boolean> {
    const resultado = await this.pool.query(`INSERT INTO notificacoes
      (id, evento_id, projeto_id, tipo_evento, motivo, canal, destinatario, assunto, mensagem, dados, criada_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
    [n.id, n.eventoId, n.projetoId, n.tipoEvento, n.motivo, n.canal, n.destinatario, n.assunto, n.mensagem, JSON.stringify(n.dados), n.criadaEm]);
    return resultado.rowCount === 1;
  }

  async listar(filtro: FiltroNotificacoes): Promise<Notificacao[]> {
    const condicoes: string[] = [];
    const valores: unknown[] = [];
    for (const [coluna, valor] of [['projeto_id', filtro.projetoId], ['destinatario', filtro.destinatario], ['canal', filtro.canal]] as const) {
      if (valor !== undefined) { valores.push(valor); condicoes.push(`${coluna} = $${valores.length}`); }
    }
    valores.push(filtro.limite ?? 200);
    const { rows } = await this.pool.query<Linha>(`SELECT * FROM notificacoes ${condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''}
      ORDER BY criada_em, canal, destinatario LIMIT $${valores.length}`, valores);
    return rows.map(paraNotificacao);
  }

  async buscar(id: string): Promise<Notificacao | null> {
    const { rows } = await this.pool.query<Linha>('SELECT * FROM notificacoes WHERE id = $1', [id]);
    return rows[0] ? paraNotificacao(rows[0]) : null;
  }

  async verificar(): Promise<void> { await this.pool.query('SELECT 1'); }
}
