// Identifica a entrega no escopo de um consumidor e guarda o hash recebido.
export interface InboxMessageState {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  processedAt?: Date;
}

// Registra a conclusão da entrega sem modificar sua identidade.
export class InboxMessage {
  private constructor(private estado: InboxMessageState) {}

  // Inicia o registro antes de confirmar o processamento.
  static receive(estado: Omit<InboxMessageState, "processedAt">): InboxMessage {
    return InboxMessage.rehydrate(estado);
  }

  // Reconstrói inclusive mensagens já processadas.
  static rehydrate(estado: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...estado, receivedAt: new Date(estado.receivedAt), processedAt: estado.processedAt && new Date(estado.processedAt) });
  }

  // Informa se a entrega já foi concluída.
  isProcessed(): boolean { return this.estado.processedAt !== undefined; }

  // Preserva a data da primeira conclusão.
  markProcessed(agora: Date): void { this.estado.processedAt ??= new Date(agora); }

  // Evita expor as datas mutáveis do registro.
  obterEstado(): InboxMessageState {
    return { ...this.estado, receivedAt: new Date(this.estado.receivedAt), processedAt: this.estado.processedAt && new Date(this.estado.processedAt) };
  }
}
