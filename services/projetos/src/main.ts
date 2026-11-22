import pg from 'pg';
import { criarApp } from './app.ts';
import { FILAS, Mensageria } from './mensageria.ts';
import { RepositorioPostgres } from './repositorio.ts';
import { ServicoProjetos } from './servico.ts';

const exigir = (nome: string): string => {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Defina ${nome} (veja .env.example).`);
  return valor;
};
const port = Number(process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');

const pool = new pg.Pool({ connectionString: exigir('DATABASE_URL'), max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
// prefetch 1: os eventos do recomendador são processados um de cada vez, na ordem da fila.
const mensageria = new Mensageria(exigir('AMQP_URL'), { servico: 'cinebridge-projetos', prefetch: 1 });
const repositorio = new RepositorioPostgres(pool);
const servico = new ServicoProjetos(repositorio, mensageria);
const app = criarApp({ servico, repositorio, mensageria });
mensageria.definirLogger(app.log);
pool.on('error', erro => app.log.error({ err: erro }, 'Erro em conexão ociosa do PostgreSQL'));

await repositorio.migrar();
mensageria.consumir(FILAS.eventosRecomendacoes, async conteudo => {
  const publicado = await servico.processarEventoRecomendacao(conteudo);
  app.log.info({ projetoId: publicado.projetoId, tipo: publicado.tipo, motivo: publicado.motivo }, 'Evento de projeto publicado');
});
mensageria.responder(FILAS.consultaProjetos, pedido => servico.atenderConsulta(pedido));
mensageria.iniciar();

let encerrando = false;
async function encerrar(): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  try { await app.close(); await mensageria.fechar(); } finally { await pool.end(); }
}
for (const sinal of ['SIGINT', 'SIGTERM'] as const) process.once(sinal, () => { void encerrar().catch(erro => { console.error(erro); process.exitCode = 1; }); });

try { await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' }); }
catch (erro) { await encerrar(); throw erro; }
