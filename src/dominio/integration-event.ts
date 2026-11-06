import type { MoneyProps } from "./money";
import type { LedgerDirection } from "./wallet-ledger-entry";

// Campos de correlação e conteúdo definidos no enunciado.
export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

// Centraliza a serialização do envelope sem depender do ORM.
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  protected constructor(private readonly estado: IntegrationEventProps<T>) {
    this.estado = structuredClone(estado);
  }

  // Emite datas em ISO e mantém o conteúdo isolado de alterações externas.
  toJSON() {
    const { occurredAt, ...campos } = structuredClone(this.estado);
    return { ...campos, occurredAt: occurredAt.toISOString(), eventType: this.eventType, version: this.version };
  }
}

// Identifica a operação aplicada, inclusive LOSS.
export class WagerTransactionProcessed extends IntegrationEvent<{ transactionId: string; walletId: string }> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  // Cria o envelope com os identificadores da operação concluída.
  constructor(estado: IntegrationEventProps<{ transactionId: string; walletId: string }>) { super(estado); }
}

// Identifica a operação rejeitada e a regra que impediu a aplicação.
export class WagerTransactionRejected extends IntegrationEvent<{ transactionId: string; walletId: string; failureCode: string }> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  // Cria o envelope com o código de falha estável.
  constructor(estado: IntegrationEventProps<{ transactionId: string; walletId: string; failureCode: string }>) { super(estado); }
}

// Identifica uma operação aceita que aguarda a referência antes de movimentar saldo.
export class WagerTransactionPendingReference extends IntegrationEvent<{
  transactionId: string; walletId: string; referenceExternalTransactionId: string;
}> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  // Registra a primeira espera durável sem produzir um evento de mudança de saldo.
  constructor(estado: IntegrationEventProps<{ transactionId: string; walletId: string; referenceExternalTransactionId: string }>) {
    super(estado);
  }
}

// Descreve uma movimentação monetária sem serializar instâncias de Money.
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

// Sinaliza uma mudança efetiva de saldo.
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  // Cria o envelope com os saldos anterior e posterior.
  constructor(estado: IntegrationEventProps<WalletBalanceChangedData>) { super(estado); }
}
