import type { Money } from "./money";

// Direções e campos do lançamento seguem o enunciado.
export type LedgerDirection = "DEBIT" | "CREDIT";
export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

// Registra uma movimentação imutável com os saldos antes e depois.
export class WalletLedgerEntry {
  private constructor(private readonly estado: LedgerEntryState) {}

  // Valida a aritmética e exige que o lançamento movimente saldo.
  static create(estado: LedgerEntryState): WalletLedgerEntry {
    const lancamento = WalletLedgerEntry.rehydrate(estado);
    if (!estado.money.isPositive() || estado.balanceBefore.isNegative() || estado.balanceAfter.isNegative() || !lancamento.isBalanced()) {
      throw new Error("Lançamento incompatível com a movimentação de saldo");
    }
    return lancamento;
  }

  // Reconstrói um lançamento existente sem repetir a validação de criação.
  static rehydrate(estado: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...estado, createdAt: new Date(estado.createdAt) });
  }

  // Confere se a direção e o valor explicam a diferença entre os saldos.
  isBalanced(): boolean {
    const { balanceBefore, balanceAfter, direction, money } = this.estado;
    return (direction === "DEBIT" ? balanceBefore.subtract(money) : balanceBefore.add(money)).equals(balanceAfter);
  }

  // Entrega uma cópia para persistência.
  obterEstado(): LedgerEntryState { return { ...this.estado, createdAt: new Date(this.estado.createdAt) }; }
}
