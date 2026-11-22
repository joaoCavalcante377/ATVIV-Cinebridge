import { criarDataSource, RepositorioPostgres } from './infrastructure/database.ts';
import { criarApp } from './http/app.ts';
import { POLITICA_PADRAO, SistemaRecomendacao } from './application/recommendation-system.ts';
import { lerPolitica } from './application/decoradores.ts';
import { fabricasPadrao } from './domain/project-factories.ts';
import { armazenamentoDoAmbiente, pagamentoDoAmbiente } from './infrastructure/adaptadores/configuracao.ts';
import { Mensageria } from './infrastructure/mensageria.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL no arquivo .env (veja .env.example).');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');
const dataSource = criarDataSource(url);
await dataSource.initialize();
// No contêiner o banco recomendacoes-db nasce vazio: as migrações rodam na inicialização.
if (process.env.DB_MIGRAR === 'true') await dataSource.runMigrations({ transaction: 'each' });

// ATVIV: com AMQP_URL a API roda no modo distribuído (RabbitMQ + demais microsserviços).
const mensageria = process.env.AMQP_URL ? new Mensageria(process.env.AMQP_URL, { servico: 'cinebridge-api', consultas: true }) : undefined;
// Provedores e pilha de decoradores vêm da configuração; o restante do sistema só conhece as interfaces.
const sistema = new SistemaRecomendacao(fabricasPadrao(), {
  armazenamento: armazenamentoDoAmbiente(), pagamento: pagamentoDoAmbiente(),
  politicaDecoradores: lerPolitica(process.env.RECOMENDACAO_DECORADORES, POLITICA_PADRAO),
});
const { app } = criarApp(new RepositorioPostgres(dataSource), { sistema, ...(mensageria ? { mensageria } : {}) });
if (mensageria) { mensageria.definirLogger(app.log); mensageria.iniciar(); }
else app.log.warn('AMQP_URL não definida: modo autônomo da ATVIII (sem RabbitMQ e sem os demais microsserviços).');

let encerrando = false;
const fechar = async (): Promise<void> => {
  if (encerrando) return;
  encerrando = true;
  try { await app.close(); await mensageria?.fechar(); } finally { await dataSource.destroy(); }
};
process.once('SIGINT', () => { void fechar().catch(erro => { console.error(erro); process.exitCode = 1; }); });
process.once('SIGTERM', () => { void fechar().catch(erro => { console.error(erro); process.exitCode = 1; }); });
try { await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' }); }
catch (erro) { await fechar(); throw erro; }
