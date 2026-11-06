import { expect, test } from "bun:test";
import { Money } from "../src/dominio/money";
import { Wallet } from "../src/dominio/wallet";
import { WagerTransaction } from "../src/dominio/wager-transaction";
import { WalletLedgerEntry } from "../src/dominio/wallet-ledger-entry";
import { InboxMessage } from "../src/dominio/inbox-message";
import { OutboxMessage } from "../src/dominio/outbox-message";
import { WagerTransactionProcessed } from "../src/dominio/integration-event";

// Centraliza a moeda e a data usadas nos exemplos de domínio.
const agora = new Date("2026-11-05T12:00:00Z");
const valor = (amount: string) => Money.from({ amount, currency: "BRL" });

// Compara valores que uma conversão para number arredondaria e verifica limites e formato.
test("Money preserva precisão, escala, intervalo e moeda", () => {
  expect(valor("90071992547409.93").add(valor("0.01")).toJSON()).toEqual({ amount: "90071992547409.94", currency: "BRL" });
  expect(() => valor("92233720368547758.07").add(valor("0.01"))).toThrow();
  expect(Money.rehydrate(-(1n << 63n), "BRL").toString()).toBe("-92233720368547758.08");
  for (const invalido of ["1", "-1.00", "1e3", "1.001", "1.00\n", "NaN", "Infinity", ""]) {
    expect(() => valor(invalido)).toThrow();
  }
  expect(() => valor("1.00").subtract(Money.zero("USD"))).toThrow();
});

// Verifica que só uma mudança real de saldo aumenta a versão da wallet.
test("Wallet rejeita saldo negativo e reidrata a versão persistida", () => {
  const wallet = Wallet.open("wallet", "jogador", valor("100.00"), agora);
  wallet.credit(valor("0.00"), agora);
  expect(wallet.version).toBe(1);
  wallet.debit(valor("80.00"), agora);
  expect(wallet.version).toBe(2);
  expect(() => wallet.debit(valor("20.01"), agora)).toThrow("Saldo insuficiente");
  const reconstruida = Wallet.rehydrate(wallet.obterEstado());
  expect(reconstruida.version).toBe(2);
  expect(reconstruida.balance.toString()).toBe("20.00");
});

// Verifica valores do recorte e que a reidratação preserva o resultado terminal.
test("WagerTransaction preserva o resultado terminal e recusa transições posteriores", () => {
  const dados = { id: "operacao", providerId: "provedor", externalTransactionId: "externa",
    idempotencyKey: "chave", payloadHash: "hash", walletId: "wallet", playerId: "jogador",
    roundId: "rodada", gameId: "jogo", createdAt: agora };
  expect(() => WagerTransaction.create({ ...dados, kind: "LOSS", money: valor("1.00") })).toThrow();
  const transacao = WagerTransaction.create({ ...dados, kind: "BET", money: valor("80.00") });
  transacao.markProcessed(valor("20.00"), agora);
  const reconstruida = WagerTransaction.rehydrate(transacao.obterEstado());
  expect(reconstruida.isTerminal()).toBe(true);
  expect(reconstruida.obterEstado().balance?.toString()).toBe("20.00");
  expect(() => reconstruida.reject("INSUFFICIENT_FUNDS", valor("0.00"), agora)).toThrow();
});

// Confere a aritmética do ledger e a proteção das datas na reidratação.
test("WalletLedgerEntry rejeita lançamento que não explica a mudança de saldo", () => {
  const dados = { id: "lancamento", walletId: "wallet", transactionId: "operacao", direction: "DEBIT" as const,
    money: valor("80.00"), balanceBefore: valor("100.00"), balanceAfter: valor("20.00"), createdAt: agora };
  expect(() => WalletLedgerEntry.create({ ...dados, balanceAfter: valor("21.00") })).toThrow();
  const lancamento = WalletLedgerEntry.rehydrate(WalletLedgerEntry.create(dados).obterEstado());
  lancamento.obterEstado().createdAt.setUTCFullYear(2000);
  expect(lancamento.obterEstado().createdAt).toEqual(agora);
  expect(lancamento.isBalanced()).toBe(true);
});

// Confere que o reenvio preserva a identidade do evento e o instante do primeiro processamento.
test("InboxMessage e OutboxMessage preservam identidade e estado entre tentativas", () => {
  const depois = new Date(agora.getTime() + 1000);
  const inbox = InboxMessage.receive({ consumerName: "consumidor", messageId: "mensagem", payloadHash: "hash", receivedAt: agora });
  inbox.markProcessed(agora);
  inbox.markProcessed(depois);
  expect(InboxMessage.rehydrate(inbox.obterEstado()).obterEstado().processedAt).toEqual(agora);

  const evento = new WagerTransactionProcessed({ eventId: "evento", aggregateId: "operacao",
    correlationId: "correlacao", occurredAt: agora, data: { walletId: "wallet", transactionId: "operacao" } });
  const outbox = OutboxMessage.enqueue(evento);
  outbox.scheduleRetry(depois);
  const reconstruida = OutboxMessage.rehydrate(outbox.obterEstado());
  expect(reconstruida.isDue(agora)).toBe(false);
  expect(reconstruida.isDue(depois)).toBe(true);
  expect(reconstruida.obterEstado().id).toBe("evento");
  expect(reconstruida.obterEstado().payload).toEqual(evento.toJSON());
  reconstruida.markPublished(depois);
  expect(() => reconstruida.scheduleRetry(depois)).toThrow();
});
