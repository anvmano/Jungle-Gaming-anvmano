// Contrato monetário do enunciado, com escala fixa e moeda explícita.
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Formata centavos exatos, inclusive totais de reconciliação fora do intervalo de uma linha.
export function formatarCentavos(centavos: bigint): string {
  const absoluto = centavos < 0n ? -centavos : centavos;
  const sinal = centavos < 0n ? "-" : "";
  return sinal + (absoluto / 100n) + "." + String(absoluto % 100n).padStart(2, "0");
}

// Distingue estouro monetário de outros erros para registrar a rejeição de um crédito.
export class ErroLimiteMonetario extends Error {}

// Representa valores exatos em centavos dentro do intervalo de BIGINT do PostgreSQL.
export class Money {
  private constructor(private readonly centavos: bigint, public readonly currency: string) {}

  // As duas casas fixas permitem converter a entrada em centavos só removendo o ponto.
  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== "string" || amount.trim() !== amount || !/^[0-9]+\.[0-9]{2}$/.test(amount)) {
      throw new Error("Informe um valor não negativo com duas casas decimais");
    }
    return Money.rehydrate(BigInt(amount.replace(".", "")), currency);
  }

  // Reconstrói um valor persistido ou calculado, inclusive quando negativo.
  static rehydrate(centavos: bigint, currency: string): Money {
    if (typeof currency !== "string" || currency.length !== 3 || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Informe uma moeda com três letras maiúsculas");
    }
    if (centavos < -(1n << 63n) || centavos >= (1n << 63n)) {
      throw new ErroLimiteMonetario("Valor fora do intervalo de BIGINT");
    }
    return new Money(centavos, currency);
  }

  // Saldo zero ainda tem moeda e segue as mesmas regras de comparação.
  static zero(currency: string): Money {
    return Money.rehydrate(0n, currency);
  }

  // A soma passa por rehydrate para detectar estouro antes de gravar no PostgreSQL.
  add(outro: Money): Money {
    this.assertSameCurrency(outro);
    return Money.rehydrate(this.centavos + outro.centavos, this.currency);
  }

  // Subtrai sem inverter o operando, que pode estar no limite inferior de BIGINT.
  subtract(outro: Money): Money {
    this.assertSameCurrency(outro);
    return Money.rehydrate(this.centavos - outro.centavos, this.currency);
  }

  // Inverte o sinal para representar a direção oposta de um movimento.
  negate(): Money {
    return Money.rehydrate(-this.centavos, this.currency);
  }

  // Permite identificar operações sem efeito financeiro.
  isZero(): boolean { return this.centavos === 0n; }

  // Identifica valores válidos para movimentações estritamente positivas.
  isPositive(): boolean { return this.centavos > 0n; }

  // Wallet usa esta comparação para impedir a gravação de saldo negativo.
  isNegative(): boolean { return this.centavos < 0n; }

  // Compara valores sem aceitar ordenação entre moedas distintas.
  isLessThan(outro: Money): boolean {
    this.assertSameCurrency(outro);
    return this.centavos < outro.centavos;
  }

  // A igualdade inclui a moeda.
  equals(outro: Money): boolean {
    return this.currency === outro.currency && this.centavos === outro.centavos;
  }

  // Expõe o valor exato ao mapeador de persistência.
  obterCentavos(): bigint { return this.centavos; }

  // Serializa dinheiro no formato exigido pelos contratos.
  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }

  // Formata a parte inteira e os centavos sem arredondamento.
  toString(): string {
    return formatarCentavos(this.centavos);
  }

  // Impede cálculos que misturem moedas.
  private assertSameCurrency(outro: Money): void {
    if (this.currency !== outro.currency) throw new Error("As moedas devem ser iguais");
  }
}
