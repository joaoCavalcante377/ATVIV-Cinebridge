#!/usr/bin/env node
/**
 * Demonstração e verificação ponta a ponta da Cinebridge containerizada (ATVIV).
 * Requer a stack em execução (docker compose up -d) e Node.js 18 ou superior; não usa dependências.
 *
 *   node scripts/demo-atv4.mjs
 *
 * Etapas: health dos 4 serviços → projeto criado no cinebridge-api (profissionais consultados via
 * consulta-profissionais) → registro no cinebridge-projetos (eventos-recomendacoes) → convites,
 * recusa, aceites e pagamento → projeto FINALIZADO → notificações (eventos-projetos) → avaliação
 * encaminhada pela fila → estatísticas das filas na API de gerenciamento do RabbitMQ.
 * Encerra com código 1 se alguma verificação falhar.
 */
const host = process.env.CINEBRIDGE_HOST ?? 'localhost';
const API = process.env.API_URL ?? `http://${host}:3000`;
const PROFISSIONAIS = process.env.PROFISSIONAIS_URL ?? `http://${host}:3001`;
const PROJETOS = process.env.PROJETOS_URL ?? `http://${host}:3002`;
const NOTIFICACOES = process.env.NOTIFICACOES_URL ?? `http://${host}:3003`;
const MQ = process.env.MQ_URL ?? `http://${host}:15672`;
const MQ_AUTH = 'Basic ' + Buffer.from(process.env.MQ_CREDENCIAIS ?? 'guest:guest').toString('base64');

let falhas = 0;
const verificar = (condicao, descricao) => {
  console.log(`  ${condicao ? '✔' : '✘'} ${descricao}`);
  if (!condicao) falhas++;
};
const etapa = titulo => console.log(`\n${titulo}`);

async function http(metodo, url, corpo, cabecalhos = {}) {
  const resposta = await fetch(url, {
    method: metodo, headers: { ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}), ...cabecalhos },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const texto = await resposta.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : undefined; } catch { dados = texto; }
  return { status: resposta.status, dados };
}
async function exigir(metodo, url, corpo, esperado = [200, 201]) {
  const r = await http(metodo, url, corpo);
  if (!esperado.includes(r.status)) throw new Error(`${metodo} ${url} → ${r.status}: ${JSON.stringify(r.dados)}`);
  return r.dados;
}
/** Aguarda uma condição assíncrona (consistência eventual entre os serviços). */
async function aguardar(descricao, consulta, condicao, timeoutMs = 20_000) {
  const limite = Date.now() + timeoutMs;
  let ultimo;
  while (Date.now() < limite) {
    try { ultimo = await consulta(); if (condicao(ultimo)) return ultimo; } catch (erro) { ultimo = erro; }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`Tempo esgotado aguardando: ${descricao}. Último valor: ${JSON.stringify(ultimo)?.slice(0, 300)}`);
}
const filas = async () => {
  const r = await http('GET', `${MQ}/api/queues/%2F`, undefined, { authorization: MQ_AUTH });
  if (r.status !== 200) throw new Error(`API de gerenciamento do RabbitMQ respondeu ${r.status}`);
  return Object.fromEntries(r.dados.map(q => [q.name, q]));
};
const publicadas = fila => fila?.message_stats?.publish ?? 0;

const projeto = {
  titulo: `Entre cenas — demo ${new Date().toISOString().slice(0, 19)}`, genero: 'drama', duracaoMinutos: 20,
  orcamentoCentavos: 600_000, inicio: '2027-03-01', prazo: '2027-03-30', tipoCaptacao: 'ficcao',
  localizacao: 'São Paulo', estrategia: 'cosseno',
  papeis: ['DIRETOR', 'DIRETOR_FOTOGRAFIA', 'SONOPLASTA', 'EDITOR', 'ROTEIRISTA', 'EFEITOS_VISUAIS'].map((papel, i) => ({
    papel, peso: i === 0 ? 2 : 1, competencias: [{ nome: 'narrativa', nivel: 5 }, { nome: 'tecnica', nivel: 5 }],
  })),
};

try {
  etapa('1. Health checks (banco + RabbitMQ em cada serviço)');
  for (const [nome, url] of [['cinebridge-api', API], ['cinebridge-profissionais', PROFISSIONAIS], ['cinebridge-projetos', PROJETOS], ['cinebridge-notificacoes', NOTIFICACOES]]) {
    const r = await http('GET', `${url}/health`);
    verificar(r.status === 200 && r.dados.banco === 'ok' && r.dados.mensageria === 'ok', `${nome} ${url}/health → ${r.status} ${JSON.stringify(r.dados)}`);
  }
  const antes = await filas();

  etapa('2. Cadastro de profissionais (cinebridge-profissionais, profissionais-db)');
  const lista = await exigir('GET', `${PROFISSIONAIS}/profissionais`);
  verificar(lista.length >= 27, `${lista.length} profissionais cadastrados (seed fictício)`);

  etapa('3. Recomendação no cinebridge-api (profissionais consultados pela fila consulta-profissionais)');
  let estado = await exigir('POST', `${API}/projetos`, projeto);
  const id = estado.projeto.id;
  console.log(`  projeto ${id}`);
  console.log(`  equipe ${estado.equipe.status}: ${estado.equipe.membros.map(m => `${m.papel}=${m.profissionalId.slice(-4)}`).join(', ')}`);
  verificar(estado.equipe.status === 'SUGERIDA' && estado.equipe.membros.length === 6, 'equipe completa sugerida com dados vindos de outro serviço');
  verificar(estado.recomendacao.degradada === false, 'recomendação não degradada (o serviço de profissionais respondeu)');

  etapa('4. Registro no cinebridge-projetos (eventos-recomendacoes) e consulta indireta via consulta-projetos');
  const registro = await aguardar('registro do projeto', () => exigir('GET', `${PROJETOS}/projetos/${id}`, undefined, [200]), p => p.status === 'EM_ANDAMENTO');
  verificar(registro.titulo === projeto.titulo, `projeto registrado no projetos-db com status ${registro.status}`);
  const acompanhamento = await exigir('GET', `${API}/projetos/${id}/acompanhamento`);
  verificar(acompanhamento.id === id, `GET ${API}/projetos/:id/acompanhamento respondeu pelo RabbitMQ (versão ${acompanhamento.versao})`);

  etapa('5. Convites: o produtor aceita, um profissional recusa, os demais aceitam');
  estado = await exigir('POST', `${API}/projetos/${id}/aceitar`, {});
  const recusado = estado.convites.find(c => c.status === 'PENDENTE');
  estado = await exigir('POST', `${API}/projetos/${id}/convites/${recusado.id}/resposta`, { profissionalId: recusado.profissionalId, resposta: 'RECUSADO' });
  console.log(`  ${recusado.papel} recusou; nova sugestão gerada para o papel`);
  estado = await exigir('POST', `${API}/projetos/${id}/aceitar`, {});
  for (const convite of estado.convites.filter(c => c.status === 'PENDENTE')) {
    estado = await exigir('POST', `${API}/projetos/${id}/convites/${convite.id}/resposta`, { profissionalId: convite.profissionalId, resposta: 'ACEITO' });
  }
  verificar(estado.equipe.status === 'CONFIRMADA', `equipe ${estado.equipe.status}`);

  etapa('6. Pagamento da equipe confirmada → projeto finalizado');
  const pagamento = await exigir('POST', `${API}/projetos/${id}/pagamentos`, undefined);
  console.log(`  ${pagamento.pagamentos.length} pagamentos via ${pagamento.provedor}`);
  const final = await aguardar('projeto FINALIZADO', () => exigir('GET', `${PROJETOS}/projetos/${id}`, undefined, [200]), p => p.status === 'FINALIZADO');
  verificar(final.status === 'FINALIZADO', `cinebridge-projetos: ${final.status}, métricas ${JSON.stringify(final.metricas)}`);
  verificar(final.metricas.convitesRecusados === 1 && final.metricas.convitesAceitos === 6, 'métricas de convites consolidadas a partir dos eventos');

  etapa('7. Notificações (cinebridge-notificacoes consumindo eventos-projetos)');
  const notificacoes = await aguardar('notificação de finalização', () => exigir('GET', `${NOTIFICACOES}/notificacoes?projetoId=${id}&limite=1000`),
    ns => ns.some(n => n.tipoEvento === 'projeto.finalizado'));
  const porMotivo = {};
  for (const n of notificacoes) porMotivo[n.motivo] = (porMotivo[n.motivo] ?? 0) + 1;
  console.log(`  ${notificacoes.length} notificações:`, porMotivo);
  verificar(['recomendacao.gerada', 'convite.criado', 'convite.respondido', 'equipe.confirmada', 'pagamentos.processados'].every(m => porMotivo[m] > 0),
    'criação, convites, respostas, confirmação e finalização notificados');
  verificar(notificacoes.some(n => n.canal === 'email') && notificacoes.some(n => n.canal === 'interno'), 'canais e-mail (simulado) e interno');
  const exemplo = notificacoes.find(n => n.motivo === 'convite.criado' && n.canal === 'email');
  if (exemplo) console.log(`  exemplo → ${exemplo.destinatario}: "${exemplo.assunto}" — ${exemplo.mensagem}`);

  etapa('8. Avaliação pelo cinebridge-api encaminhada ao cadastro pela fila');
  const avaliado = estado.equipe.membros[0].profissionalId;
  const qtd = (await exigir('GET', `${PROFISSIONAIS}/profissionais/${avaliado}`)).avaliacoes.length;
  await exigir('POST', `${API}/profissionais/${avaliado}/avaliacoes`, { nota: 5, comentario: 'Excelente trabalho na demo', data: '2027-04-01' }, [204]);
  const depois = (await exigir('GET', `${PROFISSIONAIS}/profissionais/${avaliado}`)).avaliacoes.length;
  verificar(depois === qtd + 1, `avaliação gravada no profissionais-db (${qtd} → ${depois})`);

  etapa(`9. Tráfego no RabbitMQ (${MQ}, guest/guest)`);
  // As estatísticas da API de gerenciamento são atualizadas a cada ~5 s.
  const agora = await aguardar('estatísticas do RabbitMQ', filas, f => publicadas(f['eventos-projetos']) > publicadas(antes['eventos-projetos']), 15_000);
  for (const nome of ['consulta-profissionais', 'consulta-projetos', 'eventos-recomendacoes', 'eventos-projetos']) {
    const q = agora[nome];
    console.log(`  ${nome.padEnd(24)} durável=${q.durable} consumidores=${q.consumers} prontas=${q.messages_ready} publicadas=${publicadas(q)} (+${publicadas(q) - publicadas(antes[nome])})`);
  }
  verificar(Object.entries(agora).filter(([n]) => n.endsWith('.falhas')).every(([, q]) => q.messages === 0), 'filas de falhas (dead letter) vazias');
  verificar(['consulta-profissionais', 'eventos-recomendacoes', 'eventos-projetos'].every(n => agora[n].durable && agora[n].consumers > 0), 'filas duráveis e com consumidores');
} catch (erro) {
  falhas++;
  console.error(`\n✘ ${erro.message}`);
  if (erro.cause?.code === 'ECONNREFUSED') console.error('  A stack está em execução? Rode: docker compose up -d');
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : '\nTodas as verificações passaram.');
process.exitCode = falhas ? 1 : 0;
