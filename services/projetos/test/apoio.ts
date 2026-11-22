import { ErroDominio } from '../src/dominio.ts';
import type { EventoProjeto, EventoRecomendacao, Projeto, RepositorioProjetos, StatusProjeto } from '../src/dominio.ts';

/** Dublê transacional: se a publicação falhar, a alteração é descartada (como o ROLLBACK). */
export class RepositorioMemoria implements RepositorioProjetos {
  projetos = new Map<string, Projeto>();
  processados = new Map<string, EventoProjeto>();
  offline = false;
  async listar(filtro: { status?: StatusProjeto } = {}): Promise<Projeto[]> {
    return structuredClone([...this.projetos.values()].filter(p => !filtro.status || p.status === filtro.status));
  }
  async buscar(id: string): Promise<Projeto | null> { return structuredClone(this.projetos.get(id) ?? null); }
  async criar(projeto: Projeto, aposGravar: () => Promise<void>): Promise<void> {
    if (this.projetos.has(projeto.id)) throw new ErroDominio('Projeto já existe', 409);
    await aposGravar();
    this.projetos.set(projeto.id, structuredClone(projeto));
  }
  async alterar(id: string, mudar: (atual: Projeto) => Projeto, aposGravar: (novo: Projeto) => Promise<void>): Promise<Projeto> {
    const atual = this.projetos.get(id);
    if (!atual) throw new ErroDominio('Projeto não encontrado', 404);
    const novo = mudar(structuredClone(atual));
    await aposGravar(novo);
    this.projetos.set(id, structuredClone(novo));
    return novo;
  }
  async aplicarUmaVez(evento: EventoRecomendacao, aplicar: (atual: Projeto | null) => { projeto: Projeto; publicar: EventoProjeto }): Promise<EventoProjeto> {
    const anterior = this.processados.get(evento.id);
    if (anterior) return structuredClone(anterior);
    const { projeto, publicar } = aplicar(structuredClone(this.projetos.get(evento.projetoId) ?? null));
    this.projetos.set(projeto.id, structuredClone(projeto));
    this.processados.set(evento.id, structuredClone(publicar));
    return publicar;
  }
  async verificar(): Promise<void> { if (this.offline) throw new Error('offline'); }
}

export class MensageriaMemoria {
  conectada = true;
  falhar = false;
  publicadas: { fila: string; conteudo: unknown; messageId?: string }[] = [];
  async publicar(fila: string, conteudo: unknown, propriedades: { messageId?: string } = {}): Promise<void> {
    if (this.falhar) throw Object.assign(new Error('O RabbitMQ não confirmou a publicação'), { name: 'ErroRemoto', status: 503 });
    this.publicadas.push({ fila, conteudo: structuredClone(conteudo), messageId: propriedades.messageId });
  }
}

let sequencia = 0;
export function eventoApi(tipo: string, projetoId: string, dados: Record<string, unknown> = {}, equipe: Record<string, unknown> = { status: 'SUGERIDA', custoCentavos: 90_000, integrantes: 2, papeisPendentes: [] }): EventoRecomendacao {
  return {
    id: `evento-${++sequencia}`, tipo, projetoId, ocorridoEm: new Date(Date.UTC(2027, 0, 1, 0, 0, sequencia)).toISOString(),
    dados: { destinatarios: [`produtor:${projetoId}`], ...dados, contexto: {
      projeto: { titulo: 'Entre cenas', tipoProjeto: 'padrao', genero: 'drama', orcamentoCentavos: 600_000 }, equipe,
    } },
  };
}
