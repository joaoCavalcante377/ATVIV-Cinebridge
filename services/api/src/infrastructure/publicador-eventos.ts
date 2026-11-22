import type { Evento } from '../domain/types.ts';
import type { Observador } from './event-bus.ts';
import { FILAS } from './mensageria.ts';
import type { PortaMensageria } from './mensageria.ts';

/**
 * ATVIV: observador do barramento interno que encaminha os eventos da outbox para a fila
 * `eventos-recomendacoes`, consumida pelo serviço de projetos. A publicação aguarda a confirmação
 * do RabbitMQ; se falhar, o worker mantém o evento PENDENTE e tenta de novo (entrega ao menos uma vez).
 * O id do evento vai como messageId, e o consumidor ignora repetições.
 */
export class PublicadorEventosMQ implements Observador {
  readonly nome = 'publicador-rabbitmq';
  private mensageria: Pick<PortaMensageria, 'publicar'>;
  constructor(mensageria: Pick<PortaMensageria, 'publicar'>) { this.mensageria = mensageria; }
  async atualizar(evento: Evento, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.mensageria.publicar(FILAS.eventosRecomendacoes, evento, { messageId: evento.id, type: evento.tipo });
  }
}
