import { criarNotificacao } from './dominio.ts';
import type { Canal, EventoProjeto, RepositorioNotificacoes } from './dominio.ts';
import type { Logger } from './mensageria.ts';

/** Observer: cada canal de alerta assina a central e reage aos eventos de projeto. */
export interface ObservadorProjeto {
  readonly nome: string;
  atualizar(evento: EventoProjeto): Promise<void>;
}

/**
 * Sujeito do padrão Observer. O consumidor da fila `eventos-projetos` só conhece a central; os
 * canais são acrescentados ou removidos sem alterar o consumidor. Se algum observador falhar, a
 * central lança o erro para que a mensagem seja reentregue; os que já gravaram não duplicam,
 * porque a notificação tem identificador determinístico.
 */
export class CentralEventosProjeto {
  private observadores: ObservadorProjeto[] = [];
  assinar(observador: ObservadorProjeto): void {
    if (this.observadores.some(o => o.nome === observador.nome)) throw new Error(`Observador ${observador.nome} já assinado`);
    this.observadores.push(observador);
  }
  remover(nome: string): void { this.observadores = this.observadores.filter(o => o.nome !== nome); }
  get assinantes(): string[] { return this.observadores.map(o => o.nome); }
  async notificar(evento: EventoProjeto): Promise<void> {
    const resultados = await Promise.allSettled(this.observadores.map(o => o.atualizar(evento)));
    const falhas = resultados.flatMap((r, i) => r.status === 'rejected' ? [`${this.observadores[i]!.nome}: ${String((r.reason as Error)?.message ?? r.reason)}`] : []);
    if (falhas.length) throw new Error(`Falha nos observadores: ${falhas.join('; ')}`);
  }
}

abstract class NotificadorCanal implements ObservadorProjeto {
  abstract readonly nome: string;
  protected abstract readonly canal: Canal;
  protected repositorio: RepositorioNotificacoes;
  protected log: Logger;
  constructor(repositorio: RepositorioNotificacoes, log: Logger) { this.repositorio = repositorio; this.log = log; }
  /** Quem recebe por este canal. */
  protected destinatarios(evento: EventoProjeto): string[] { return evento.destinatarios; }
  protected abstract entregar(destinatario: string, assunto: string, mensagem: string, evento: EventoProjeto): void;
  async atualizar(evento: EventoProjeto): Promise<void> {
    for (const destinatario of this.destinatarios(evento)) {
      const notificacao = criarNotificacao(evento, this.canal, destinatario);
      if (await this.repositorio.salvar(notificacao)) this.entregar(destinatario, notificacao.assunto, notificacao.mensagem, evento);
    }
  }
}

/** E-mail simulado: registra a mensagem e o log de envio, sem servidor SMTP. */
export class NotificadorEmail extends NotificadorCanal {
  readonly nome = 'email';
  protected readonly canal = 'email' as const;
  protected entregar(destinatario: string, assunto: string, _mensagem: string, evento: EventoProjeto): void {
    this.log.info({ canal: 'email', destinatario, assunto, projetoId: evento.projetoId }, 'E-mail registrado (envio simulado)');
  }
}

/** Mensagem interna da plataforma: produtor e profissionais consultam em GET /notificacoes. */
export class NotificadorInterno extends NotificadorCanal {
  readonly nome = 'interno';
  protected readonly canal = 'interno' as const;
  protected entregar(destinatario: string, assunto: string, _mensagem: string, evento: EventoProjeto): void {
    this.log.info({ canal: 'interno', destinatario, assunto, projetoId: evento.projetoId }, 'Mensagem interna disponível');
  }
}
