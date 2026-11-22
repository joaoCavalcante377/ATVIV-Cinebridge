import { PAPEIS } from './dominio.ts';
import type { Profissional } from './dominio.ts';

/** Os mesmos 27 profissionais fictícios do seed das atividades anteriores (IDs fixos; repetir atualiza). */
export function profissionaisFicticios(): Profissional[] {
  const gerais: Profissional[] = Array.from({ length: 18 }, (_, i) => {
    const papel = PAPEIS[i % PAPEIS.length]!;
    const variante = Math.floor(i / PAPEIS.length) % 3;
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      nome: `${['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio'][i % 6]} ${i + 1}`,
      email: `profissional${i + 1}@example.com`, papeis: [papel],
      competencias: [{ nome: 'narrativa', nivel: [5, 3, 4][variante]! }, { nome: 'tecnica', nivel: [5, 3, 4][variante]! }],
      precoCentavos: [90_000, 40_000, 65_000][variante]!,
      disponibilidade: { inicio: '2026-01-01', fim: '2035-12-31' }, localizacao: 'São Paulo',
      historico: [
        { projetoId: 'curta-anterior-1', genero: 'drama', tipoCaptacao: 'ficcao', papel, nota: [3, 4, 5][variante]! },
        { projetoId: 'curta-anterior-2', genero: 'drama', tipoCaptacao: 'ficcao', papel, nota: [2, 3, 5][variante]! },
      ],
      avaliacoes: [{ nota: [3, 4, 5][variante]!, comentario: 'Dado fictício para demonstração.', data: '2026-06-01' }],
    };
  });
  const especialidades = [['entrevista', 'captacao direta'], ['modelagem 3d', 'Blender'], ['publicidade', 'storytelling']];
  const familias: Profissional[] = especialidades.flatMap((competencias, familia) => Array.from({ length: 3 }, (_, i) => ({
    id: `10000000-0000-4000-8000-${String(familia * 3 + i + 1).padStart(12, '0')}`,
    nome: `${['Documentarista', 'Animador', 'Publicitário'][familia]} ${i + 1}`,
    email: `familia${familia}-profissional${i}@example.com`, papeis: [...PAPEIS],
    competencias: competencias.map(nome => ({ nome, nivel: 5 })), precoCentavos: 50_000,
    disponibilidade: { inicio: '2026-01-01', fim: '2035-12-31' }, localizacao: 'São Paulo',
    historico: [], avaliacoes: [{ nota: 4, comentario: 'Dado fictício para demonstração', data: '2026-06-01' }],
  })));
  return [...gerais, ...familias];
}
