import { expect, test } from "bun:test";
import { Money } from "../src/dominio/money";
import { WagerTransaction, type DadosTransacao, type WagerTransactionKind,
  type WagerTransactionState } from "../src/dominio/wager-transaction";
import { lerTransacao } from "../src/aplicacao/contratos-financeiros";

// Mantém valores exatos e identidades independentes nos cenários de referência.
const agora = new Date("2026-11-05T12:00:00Z");
const valor = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const dados: DadosTransacao = {
  id: "original", providerId: "provedor", externalTransactionId: "externa-original",
  idempotencyKey: "chave-original", payloadHash: "hash", walletId: "wallet", playerId: "jogador",
  roundId: "rodada", gameId: "jogo", kind: "BET", money: valor("80.00"), createdAt: agora,
};

// Representa a leitura de uma referência já aplicada, com mudanças explícitas em cada cenário.
function referencia(alteracoes: Partial<WagerTransactionState> = {}): WagerTransactionState {
  return { ...dados, status: "PROCESSED", balance: valor("20.00"), processedAt: agora, ...alteracoes };
}

// Cria a operação dependente sem aplicar qualquer efeito financeiro.
function operacao(kind: WagerTransactionKind = "REFUND", alteracoes: Partial<DadosTransacao> = {}) {
  return WagerTransaction.create({ ...dados, id: "dependente", externalTransactionId: "externa-dependente",
    idempotencyKey: "chave-dependente", referenceExternalTransactionId: dados.externalTransactionId,
    kind, ...alteracoes });
}

// Exercita a matriz completa de tipos, inclusive os alvos proibidos.
test("WIN, REFUND e ROLLBACK aceitam somente os tipos de referência previstos", () => {
  const tipos: WagerTransactionKind[] = ["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"];
  for (const kind of ["WIN", "REFUND", "ROLLBACK"] as const) {
    for (const tipoReferencia of tipos) {
      const resultado = operacao(kind).avaliarReferencia(referencia({ kind: tipoReferencia }), [], valor("80.00"));
      const permitido = tipoReferencia === "BET" || (kind === "ROLLBACK" && ["WIN", "REFUND"].includes(tipoReferencia));
      expect(resultado).toEqual(permitido
        ? { situacao: "liberada", referenceTransactionId: "original",
          direction: kind === "ROLLBACK" && tipoReferencia !== "BET" ? "DEBIT" : "CREDIT" }
        : { situacao: "rejeitar", failureCode: "REFERENCE_MISMATCH" });
    }
  }
});

// Divergências conhecidas não se transformam em espera nem dependem do saldo da referência.
test("Referência valida identidade, pertencimento, moeda e rodada antes do estado", () => {
  const divergencias: Partial<WagerTransactionState>[] = [
    { providerId: "outro" }, { externalTransactionId: "outra" }, { playerId: "outro" },
    { walletId: "outra" }, { roundId: "outra" }, { money: valor("80.00", "USD") },
  ];
  for (const kind of ["WIN", "REFUND", "ROLLBACK"] as const) {
    for (const divergencia of divergencias) {
      for (const status of ["PROCESSED", "PENDING", "REJECTED"] as const) {
        expect(operacao(kind).avaliarReferencia(referencia({ ...divergencia, status }), [], valor("80.00")))
          .toEqual({ situacao: "rejeitar", failureCode: "REFERENCE_MISMATCH" });
      }
    }
  }
  // gameId permanece no hash, mas não cria uma restrição adicional entre referência e dependente.
  expect(operacao().avaliarReferencia(referencia({ gameId: "outro-jogo" }), [], valor("20.00")).situacao).toBe("liberada");
});

// Reversões são integrais; o prêmio pode ser diferente do valor apostado.
test("Reversões exigem igualdade monetária, enquanto WIN permite prêmio diferente", () => {
  for (const kind of ["REFUND", "ROLLBACK"] as const) {
    for (const amount of ["79.99", "80.01"]) {
      expect(operacao(kind, { money: valor(amount) }).avaliarReferencia(referencia(), [], valor("100.00")))
        .toEqual({ situacao: "rejeitar", failureCode: "REFERENCE_MISMATCH" });
    }
  }
  expect(operacao("WIN", { money: valor("30.00") }).avaliarReferencia(referencia(), [], valor("20.00")))
    .toEqual({ situacao: "liberada", referenceTransactionId: "original", direction: "CREDIT" });
});

// A ausência ou pendência é recuperável; uma referência terminal sem aplicação é definitiva.
test("Referências ausentes ou pendentes aguardam; REJECTED e FAILED rejeitam", () => {
  for (const kind of ["WIN", "REFUND", "ROLLBACK"] as const) {
    expect(operacao(kind).avaliarReferencia(undefined, [], valor("20.00"))).toEqual({ situacao: "aguardar" });
    for (const status of ["PENDING", "PENDING_REFERENCE", "REJECTED", "FAILED"] as const) {
      expect(operacao(kind).avaliarReferencia(referencia({ status }), [], valor("20.00")))
        .toEqual(status === "PENDING" || status === "PENDING_REFERENCE"
          ? { situacao: "aguardar" } : { situacao: "rejeitar", failureCode: "REFERENCE_NOT_PROCESSED" });
    }
  }
});

// Impede dois créditos diretos à mesma BET em todas as combinações dos tipos de reversão.
test("REFUND e ROLLBACK compartilham exclusividade somente quando efetivamente processados", () => {
  for (const anterior of ["REFUND", "ROLLBACK"] as const) {
    for (const proxima of ["REFUND", "ROLLBACK"] as const) {
      for (const status of ["PENDING", "PENDING_REFERENCE", "PROCESSED", "REJECTED", "FAILED"] as const) {
        const reversao = referencia({ id: "reversao", kind: anterior, referenceTransactionId: "original", status });
        expect(operacao(proxima).avaliarReferencia(referencia(), [reversao], valor("100.00")))
          .toEqual(status === "PROCESSED" ? { situacao: "rejeitar", failureCode: "ALREADY_REVERSED" }
            : { situacao: "liberada", referenceTransactionId: "original", direction: "CREDIT" });
      }
    }
  }
  // Uma reversão de outra referência e um prêmio não consomem a exclusividade da BET.
  for (const anterior of [referencia({ kind: "REFUND", referenceTransactionId: "outra" }),
    referencia({ kind: "WIN", referenceTransactionId: "original" })]) {
    expect(operacao().avaliarReferencia(referencia(), [anterior], valor("20.00")).situacao).toBe("liberada");
  }
});

// Desfazer créditos exige saldo suficiente e a tentativa rejeitada não bloqueia outra identidade.
test("ROLLBACK de WIN e REFUND debita integralmente ou rejeita por saldo insuficiente", () => {
  for (const kind of ["WIN", "REFUND"] as const) {
    const original = referencia({ kind });
    expect(operacao("ROLLBACK").avaliarReferencia(original, [], valor("79.99")))
      .toEqual({ situacao: "rejeitar", failureCode: "REVERSAL_INSUFFICIENT_FUNDS" });
    const rejeitada = referencia({ id: "tentativa", kind: "ROLLBACK", referenceTransactionId: "original", status: "REJECTED" });
    expect(operacao("ROLLBACK").avaliarReferencia(original, [rejeitada], valor("80.00")))
      .toEqual({ situacao: "liberada", referenceTransactionId: "original", direction: "DEBIT" });
    expect(operacao("ROLLBACK").avaliarReferencia(original, [{ ...rejeitada, status: "PROCESSED" }], valor("80.00")))
      .toEqual({ situacao: "rejeitar", failureCode: "ALREADY_REVERSED" });
  }
});

// A compensação do REFUND não apaga o fato de que a BET já recebeu uma reversão direta.
test("ROLLBACK de REFUND é permitido, mas não reabre a BET para outro crédito de reversão", () => {
  const refund = referencia({ id: "refund", externalTransactionId: "externa-refund", kind: "REFUND", referenceTransactionId: "original" });
  const rollback = referencia({ id: "rollback", kind: "ROLLBACK", referenceTransactionId: "refund" });
  expect(operacao("ROLLBACK", { referenceExternalTransactionId: "externa-refund" })
    .avaliarReferencia(refund, [refund], valor("100.00")))
    .toEqual({ situacao: "liberada", referenceTransactionId: "refund", direction: "DEBIT" });
  expect(operacao().avaliarReferencia(referencia(), [refund, rollback], valor("20.00")))
    .toEqual({ situacao: "rejeitar", failureCode: "ALREADY_REVERSED" });
  // WIN não é reversão: a existência do REFUND não impede prêmio válido da mesma rodada.
  expect(operacao("WIN").avaliarReferencia(referencia(), [refund], valor("20.00")).situacao).toBe("liberada");
});

// As factories rejeitam contratos impossíveis, mas rehydrate continua sem repetir validações.
test("Criação exige referências válidas por tipo e recusa autorreferência", () => {
  for (const kind of ["REFUND", "ROLLBACK"] as const) {
    expect(() => operacao(kind, { referenceExternalTransactionId: undefined })).toThrow();
    expect(() => operacao(kind, { money: valor("0.00") })).toThrow();
  }
  for (const kind of ["BET", "LOSS", "OPENING"] as const) {
    expect(() => operacao(kind, { money: valor(kind === "LOSS" ? "0.00" : "80.00") })).toThrow("Referência incompatível");
  }
  expect(() => operacao("WIN", { referenceExternalTransactionId: "" })).toThrow();
  expect(() => operacao("WIN", { referenceExternalTransactionId: "externa-dependente" })).toThrow("si mesma");
  expect(operacao("WIN", { referenceExternalTransactionId: undefined }).obterEstado().status).toBe("PENDING");
  expect(() => WagerTransaction.rehydrate(referencia({ kind: "REFUND", referenceExternalTransactionId: undefined }))).not.toThrow();
});

// Avaliar é uma consulta pura; aguardar pode concluir depois, mas estados terminais são imutáveis.
test("Avaliação preserva estado e as transições funcionam após reidratação", () => {
  const pendente = operacao();
  const estadoInicial = pendente.obterEstado();
  pendente.avaliarReferencia(referencia(), [], valor("20.00"));
  expect(pendente.obterEstado()).toEqual(estadoInicial);
  pendente.markPendingReference();
  const reconstruida = WagerTransaction.rehydrate(pendente.obterEstado());
  reconstruida.markPendingReference();
  expect(reconstruida.avaliarReferencia(referencia(), [], valor("20.00")).situacao).toBe("liberada");
  reconstruida.markProcessed(valor("100.00"), agora, "original");
  expect(reconstruida.obterEstado().referenceTransactionId).toBe("original");
  for (const inicial of ["PENDING", "PENDING_REFERENCE"] as const) {
    for (const terminal of ["PROCESSED", "REJECTED", "FAILED"] as const) {
      const transacao = WagerTransaction.rehydrate({ ...estadoInicial, status: inicial });
      if (terminal === "PROCESSED") transacao.markProcessed(valor("100.00"), agora, "original");
      if (terminal === "REJECTED") transacao.reject("REFERENCE_EXPIRED", valor("20.00"), agora);
      if (terminal === "FAILED") transacao.fail("FALHA_PERMANENTE", agora);
      const final = WagerTransaction.rehydrate(transacao.obterEstado());
      expect(final.obterEstado().status).toBe(terminal);
      expect(() => final.markPendingReference()).toThrow();
      expect(() => final.markProcessed(valor("100.00"), agora, "original")).toThrow();
      expect(() => final.reject("REFERENCE_EXPIRED", valor("20.00"), agora)).toThrow();
      expect(() => final.fail("FALHA_PERMANENTE", agora)).toThrow();
      expect(() => final.avaliarReferencia(referencia(), [], valor("20.00"))).toThrow();
    }
  }
});

// A mesma validação admite dependências nos dois canais e rejeita contratos sem significado.
test("HTTP e SQS aceitam referências válidas e recusam contratos inválidos", () => {
  const corpo = { providerId: "provedor", externalTransactionId: "nova", playerId: "00000000-0000-0000-0000-000000000001",
    walletId: "00000000-0000-0000-0000-000000000002", roundId: "rodada", gameId: "jogo", money: valor("80.00").toJSON() };
  expect(lerTransacao({ ...corpo, kind: "WIN" }, "chave").kind).toBe("WIN");
  for (const kind of ["REFUND", "ROLLBACK", "WIN"] as const) {
    expect(lerTransacao({ ...corpo, kind, referenceExternalTransactionId: "externa-original" }, "chave")
      .referenceExternalTransactionId).toBe("externa-original");
    for (const referenciaInvalida of [null, "", " nova", "nova", "a".repeat(129)]) {
      expect(() => lerTransacao({ ...corpo, kind, referenceExternalTransactionId: referenciaInvalida }, "chave")).toThrow();
    }
  }
  for (const kind of ["REFUND", "ROLLBACK"] as const) {
    expect(() => lerTransacao({ ...corpo, kind }, "chave")).toThrow();
  }
  for (const kind of ["BET", "LOSS", "OPENING"] as const) {
    expect(() => lerTransacao({ ...corpo, kind, money: valor(kind === "LOSS" ? "0.00" : "80.00").toJSON(),
      referenceExternalTransactionId: "externa-original" }, "chave")).toThrow();
  }
});
