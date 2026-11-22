import pg from 'pg';
import { criarApp } from './app.ts';
import { validarEvento } from './dominio.ts';
import { FILAS, Mensageria } from './mensageria.ts';
import { CentralEventosProjeto, NotificadorEmail, NotificadorInterno } from './observadores.ts';
import { RepositorioPostgres } from './repositorio.ts';

const exigir = (nome: string): string => {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Defina ${nome} (veja .env.example).`);
  return valor;
};
const port = Number(process.env.PORT ?? 3003);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');

const pool = new pg.Pool({ connectionString: exigir('DATABASE_URL'), max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
const repositorio = new RepositorioPostgres(pool);
const mensageria = new Mensageria(exigir('AMQP_URL'), { servico: 'cinebridge-notificacoes' });
const central = new CentralEventosProjeto();
const app = criarApp({ repositorio, mensageria, assinantes: () => central.assinantes });
mensageria.definirLogger(app.log);
pool.on('error', erro => app.log.error({ err: erro }, 'Erro em conexão ociosa do PostgreSQL'));

// Canais assinantes (Observer). Ex.: CANAIS=email desativa as mensagens internas.
const canais = (process.env.CANAIS ?? 'email,interno').split(',').map(c => c.trim()).filter(Boolean);
if (canais.includes('email')) central.assinar(new NotificadorEmail(repositorio, app.log));
if (canais.includes('interno')) central.assinar(new NotificadorInterno(repositorio, app.log));

await repositorio.migrar();
mensageria.consumir(FILAS.eventosProjetos, async conteudo => {
  const evento = validarEvento(conteudo);
  await central.notificar(evento);
  app.log.info({ eventoId: evento.id, tipo: evento.tipo, motivo: evento.motivo, destinatarios: evento.destinatarios.length }, 'Evento de projeto notificado');
});
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
