import { Money } from "../dominio/money";

// Envia centavos ao driver sem perder precisão.
export function gravarMoney(money: Money): string {
  return money.obterCentavos().toString();
}

// Reconstrói dinheiro a partir da representação textual devolvida pelo driver.
export function lerMoney(centavos: string, currency: string): Money {
  if (typeof centavos !== "string") throw new Error("O driver deve retornar BIGINT como texto");
  return Money.rehydrate(BigInt(centavos), currency);
}
