import { Money } from "./money";

// A versão e as datas vêm da linha persistida ao carregar a wallet.
export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// Mantém a versão alinhada às alterações reais do saldo.
export class Wallet {
  private constructor(private estado: WalletState) {}

  // A wallet começa na versão 1, inclusive quando é aberta com saldo zero.
  static open(id: string, playerId: string, initialBalance: Money, agora: Date): Wallet {
    if (initialBalance.isNegative()) throw new Error("O saldo inicial não pode ser negativo");
    return Wallet.rehydrate({ id, playerId, balance: initialBalance, version: 1, createdAt: agora, updatedAt: agora });
  }

  // Reconstrói o estado persistido sem reaplicar a abertura.
  static rehydrate(estado: WalletState): Wallet {
    return new Wallet({ ...estado, createdAt: new Date(estado.createdAt), updatedAt: new Date(estado.updatedAt) });
  }

  // Money é imutável, então o saldo pode ser lido sem criar uma cópia.
  get balance(): Money { return this.estado.balance; }

  // A versão começa em 1 e avança quando o saldo muda.
  get version(): number { return this.estado.version; }

  // Money.add confere a moeda antes de aplicar o crédito.
  credit(money: Money, agora: Date): void {
    if (money.isNegative()) throw new Error("O crédito não pode ser negativo");
    this.alterarSaldo(this.balance.add(money), agora);
  }

  // A subtração pode produzir um valor negativo, mas alterarSaldo impede que ele vire saldo.
  debit(money: Money, agora: Date): void {
    if (money.isNegative()) throw new Error("O débito não pode ser negativo");
    this.alterarSaldo(this.balance.subtract(money), agora);
  }

  // Gera uma cópia para persistência sem expor as datas internas.
  obterEstado(): WalletState {
    return { ...this.estado, createdAt: new Date(this.estado.createdAt), updatedAt: new Date(this.estado.updatedAt) };
  }

  // Preserva a versão e a data quando o saldo continua igual.
  private alterarSaldo(balance: Money, agora: Date): void {
    if (balance.isNegative()) throw new Error("Saldo insuficiente");
    if (balance.equals(this.balance)) return;
    this.estado = { ...this.estado, balance, version: this.version + 1, updatedAt: new Date(agora) };
  }
}
