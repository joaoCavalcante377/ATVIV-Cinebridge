import pg from 'pg';
import { criarApp } from './app.ts';
import { atenderConsultas } from './consultas.ts';
import { FILAS, Mensageria } from './mensageria.ts';
import { RepositorioPostgres } from './repositorio.ts';
import { profissionaisFicticios } from './seed.ts';

const exigir = (nome: string): string => {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Defina ${nome} (veja .env.example).`);
  return valor;
};
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');

const pool = new pg.Pool({ connectionString: exigir('DATABASE_URL'), max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
pool.on('error', erro => app.log.error({ err: erro }, 'Erro em conexão ociosa do PostgreSQL'));
const repositorio = new RepositorioPostgres(pool);
const mensageria = new Mensageria(exigir('AMQP_URL'), { servico: 'cinebridge-profissionais' });
const app = criarApp({ repositorio, mensageria });
mensageria.definirLogger(app.log);

await repositorio.migrar();
if (process.env.SEED !== 'false') {
  const lista = profissionaisFicticios();
  // Só insere quem ainda não existe: reiniciar o contêiner não desfaz avaliações registradas.
  for (const profissional of lista) if (!(await repositorio.buscar(profissional.id))) await repositorio.salvar(profissional);
  app.log.info({ quantidade: lista.length }, 'Profissionais fictícios conferidos');
}

// Consumidor da fila consulta-profissionais: responde na fila de retorno indicada pelo solicitante.
mensageria.responder(FILAS.consultaProfissionais, atenderConsultas(repositorio));
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
