import test from 'node:test';
import assert from 'node:assert/strict';
import { atenderConsultas } from '../src/consultas.ts';
import { RepositorioMemoria, profissional } from './apoio.ts';

test('consulta-profissionais lista com critérios, detalha e registra avaliação', async () => {
  const repo = new RepositorioMemoria();
  await repo.salvar(profissional('a'));
  await repo.salvar(profissional('b', { papeis: ['DIRETOR'] }));
  const atender = atenderConsultas(repo);
  assert.deepEqual((await atender({ operacao: 'listar', criterios: { papeis: ['DIRETOR'] } }) as { id: string }[]).map(p => p.id), ['b']);
  assert.equal((await atender({ operacao: 'listar' }) as unknown[]).length, 2);
  assert.equal((await atender({ operacao: 'detalhar', id: 'a' }) as { id: string }).id, 'a');
  const avaliado = await atender({ operacao: 'avaliar', id: 'a', avaliacao: { nota: 5, comentario: 'Ótimo', data: '2027-04-01' } }) as { avaliacoes: unknown[] };
  assert.equal(avaliado.avaliacoes.length, 1);
});

test('pedidos inválidos retornam erros com status HTTP equivalente', async () => {
  const atender = atenderConsultas(new RepositorioMemoria());
  for (const [pedido, status] of [
    [null, 400], [{ operacao: 'apagar' }, 400], [{ operacao: 'detalhar' }, 400], [{ operacao: 'detalhar', id: 'x' }, 404],
    [{ operacao: 'listar', criterios: { papeis: ['ATOR'] } }, 400], [{ operacao: 'listar', criterios: { limite: 0 } }, 400],
    [{ operacao: 'avaliar', id: 'x', avaliacao: { nota: 9, comentario: '', data: '2027-01-01' } }, 422],
  ] as const) {
    await assert.rejects(atender(pedido), (erro: { status: number }) => erro.status === status, JSON.stringify(pedido));
  }
});
