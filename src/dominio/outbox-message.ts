import type { IntegrationEvent } from "./integration-event";

// Mantém o envelope e o agendamento separados para preservar o evento nos reenvios.
export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

// Preserva o identificador do evento até a confirmação da publicação.
export class OutboxMessage {
  private constructor(private estado: OutboxMessageState) {}

  // Usa eventId como identidade persistente da mensagem.
  static enqueue(evento: IntegrationEvent<unknown>): OutboxMessage {
    const payload = evento.toJSON();
    return OutboxMessage.rehydrate({
      id: payload.eventId, aggregateId: payload.aggregateId, eventType: payload.eventType,
      occurredAt: new Date(payload.occurredAt), payload, attempts: 0,
    });
  }

  // Reconstrói inclusive publicações concluídas e tentativas agendadas.
  static rehydrate(estado: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(structuredClone(estado));
  }

  // O evento continua pendente até que a confirmação do broker fique gravada.
  isPending(): boolean { return this.estado.publishedAt === undefined; }

  // Eventos novos podem sair de imediato. Reenvios esperam o horário agendado.
  isDue(agora: Date): boolean {
    return this.isPending() && (!this.estado.nextAttemptAt || this.estado.nextAttemptAt <= agora);
  }

  // Preserva a data da primeira publicação confirmada.
  markPublished(agora: Date): void {
    this.estado.publishedAt ??= new Date(agora);
    this.estado.nextAttemptAt = undefined;
  }

  // Registra a tentativa malsucedida e o novo instante calculado pelo publicador.
  scheduleRetry(nextAttemptAt: Date): void {
    if (!this.isPending()) throw new Error("O evento já foi publicado");
    this.estado.attempts++;
    this.estado.nextAttemptAt = new Date(nextAttemptAt);
  }

  // Copia também o payload e as datas para que o chamador não altere o registro interno.
  obterEstado(): OutboxMessageState { return structuredClone(this.estado); }
}
