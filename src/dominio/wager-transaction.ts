import type { Money } from "./money";
import type { LedgerDirection } from "./wallet-ledger-entry";

// Nomes de operações e estados seguem o enunciado.
export type WagerTransactionKind = "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
export type WagerTransactionStatus = "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";

// Identidade e dados imutáveis recebidos pelo processador.
export interface DadosTransacao {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

// Estado persistido, incluindo o saldo histórico para respostas de replay.
export interface WagerTransactionState extends DadosTransacao {
  status: WagerTransactionStatus;
  balance?: Money;
  failureCode?: string;
  processedAt?: Date;
  referenceTransactionId?: string;
}

// Separa espera de rejeição definitiva sem aplicar saldo ou mudar o estado da operação.
export type DecisaoReferencia =
  | { situacao: "aguardar" }
  | { situacao: "rejeitar"; failureCode: "REFERENCE_MISMATCH" | "REFERENCE_NOT_PROCESSED" | "ALREADY_REVERSED" | "REVERSAL_INSUFFICIENT_FUNDS" }
  | { situacao: "liberada"; referenceTransactionId: string; direction: LedgerDirection };

// Controla as transições sem alterar a identidade da operação.
export class WagerTransaction {
  private constructor(private estado: WagerTransactionState) {}

  // LOSS é o único tipo que aceita zero. Reversões exigem referência desde a criação.
  static create(dados: DadosTransacao): WagerTransaction {
    const { kind, money, referenceExternalTransactionId, externalTransactionId } = dados;
    if (kind === "LOSS" ? !money.isZero() : !money.isPositive()) {
      throw new Error("Valor incompatível com o tipo de operação");
    }
    if ((kind === "REFUND" || kind === "ROLLBACK") && !referenceExternalTransactionId) {
      throw new Error("A reversão exige uma transação de referência");
    }
    if (referenceExternalTransactionId !== undefined &&
      (referenceExternalTransactionId.length === 0 || !["WIN", "REFUND", "ROLLBACK"].includes(kind))) {
      throw new Error("Referência incompatível com o tipo de operação");
    }
    if (referenceExternalTransactionId === externalTransactionId) {
      throw new Error("A transação não pode referenciar a si mesma");
    }
    return WagerTransaction.rehydrate({ ...dados, status: "PENDING" });
  }

  // Recupera inclusive transações terminais sem repetir validações de criação.
  static rehydrate(estado: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      ...estado,
      createdAt: new Date(estado.createdAt),
      processedAt: estado.processedAt && new Date(estado.processedAt),
    });
  }

  // Identifica operações que não podem mais sofrer transições.
  isTerminal(): boolean {
    return this.estado.status === "PROCESSED" || this.estado.status === "REJECTED" || this.estado.status === "FAILED";
  }

  // Compara o hash canônico para distinguir reenvio de conflito.
  matchesPayload(payloadHash: string): boolean { return this.estado.payloadHash === payloadHash; }

  // Avalia uma referência com o saldo e as reversões lidos sob o lock da wallet pelo processador.
  avaliarReferencia(referencia: WagerTransactionState | undefined,
    reversoes: readonly WagerTransactionState[], saldoDisponivel: Money): DecisaoReferencia {
    const dados = this.estado;
    if (this.isTerminal() || !dados.referenceExternalTransactionId) {
      throw new Error("Somente uma operação não terminal com referência pode ser avaliada");
    }
    if (saldoDisponivel.currency !== dados.money.currency) {
      throw new Error("A moeda da wallet deve ser validada antes da referência");
    }
    if (!referencia) return { situacao: "aguardar" };

    // Uma incompatibilidade conhecida é definitiva, mesmo quando a referência ainda está pendente.
    const tipoPermitido = dados.kind === "ROLLBACK"
      ? ["BET", "WIN", "REFUND"].includes(referencia.kind) : referencia.kind === "BET";
    if (referencia.providerId !== dados.providerId ||
      referencia.externalTransactionId !== dados.referenceExternalTransactionId ||
      referencia.playerId !== dados.playerId || referencia.walletId !== dados.walletId ||
      referencia.money.currency !== dados.money.currency || referencia.roundId !== dados.roundId ||
      !tipoPermitido || (dados.kind !== "WIN" && !dados.money.equals(referencia.money))) {
      return { situacao: "rejeitar", failureCode: "REFERENCE_MISMATCH" };
    }
    if (referencia.status === "REJECTED" || referencia.status === "FAILED") {
      return { situacao: "rejeitar", failureCode: "REFERENCE_NOT_PROCESSED" };
    }
    if (referencia.status !== "PROCESSED") return { situacao: "aguardar" };

    // REFUND e ROLLBACK compartilham a exclusividade da reversão direta de uma BET.
    if (dados.kind !== "WIN" && reversoes.some((reversao) =>
      reversao.referenceTransactionId === referencia.id && reversao.status === "PROCESSED" &&
      (reversao.kind === "REFUND" || reversao.kind === "ROLLBACK"))) {
      return { situacao: "rejeitar", failureCode: "ALREADY_REVERSED" };
    }
    // Desfazer WIN ou REFUND exige devolver o crédito, sem permitir saldo negativo.
    const direction = dados.kind === "ROLLBACK" && referencia.kind !== "BET" ? "DEBIT" : "CREDIT";
    if (direction === "DEBIT" && saldoDisponivel.isLessThan(dados.money)) {
      return { situacao: "rejeitar", failureCode: "REVERSAL_INSUFFICIENT_FUNDS" };
    }
    return { situacao: "liberada", referenceTransactionId: referencia.id, direction };
  }

  // Guarda o saldo da decisão para que reenvios devolvam o mesmo valor.
  markProcessed(balance: Money, agora: Date, referenceTransactionId?: string): void {
    this.transicionar({ status: "PROCESSED", balance, processedAt: new Date(agora), referenceTransactionId });
  }

  // A pendência fica sem saldo histórico até o worker concluir a operação.
  markPendingReference(): void {
    if (!this.estado.referenceExternalTransactionId) throw new Error("A transação não tem referência");
    this.transicionar({ status: "PENDING_REFERENCE" });
  }

  // Registra uma rejeição de negócio e o saldo observado.
  reject(failureCode: string, balance: Money, agora: Date): void {
    this.transicionar({ status: "REJECTED", failureCode, balance, processedAt: new Date(agora) });
  }

  // Registra uma falha permanente quando o resultado é conhecido.
  fail(failureCode: string, agora: Date): void {
    this.transicionar({ status: "FAILED", failureCode, processedAt: new Date(agora) });
  }

  // Copia as datas para que a leitura do estado não altere o histórico da transação.
  obterEstado(): WagerTransactionState {
    return { ...this.estado, createdAt: new Date(this.estado.createdAt), processedAt: this.estado.processedAt && new Date(this.estado.processedAt) };
  }

  // Uma transição pode mudar o resultado, mas preserva a identidade e o conteúdo recebidos.
  private transicionar(resultado: Pick<WagerTransactionState, "status" | "balance" | "failureCode" | "processedAt" | "referenceTransactionId">): void {
    if (this.isTerminal()) throw new Error("A transação já está em estado terminal");
    this.estado = { ...this.estado, ...resultado };
  }
}
