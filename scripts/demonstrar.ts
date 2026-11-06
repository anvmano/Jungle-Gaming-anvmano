import verificar from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { criarClienteSqs, localizarFilas } from "../src/infraestrutura/filas";
import { conectarPostgres } from "../src/infraestrutura/postgres";

// Cria dados de demonstração pela API e acompanha o processamento SQS no Compose.
const base = process.env.URL_APLICACAO ?? "http://127.0.0.1:3001";
const cliente = criarClienteSqs();
const banco = await conectarPostgres();
try {
  const abertura = await fetch(base + "/wallets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } }),
    signal: AbortSignal.timeout(8000),
  });
  verificar.equal(abertura.status, 201);
  const wallet = await abertura.json();
  const id = randomUUID();
  const comando = {
    messageId: id, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
    data: { providerId: "demonstracao", externalTransactionId: id, idempotencyKey: id,
      walletId: wallet.id, playerId: wallet.playerId, roundId: id, gameId: "jogo",
      kind: "BET", money: { amount: "80.00", currency: "BRL" } },
  };
  const filas = await localizarFilas(cliente);
  await cliente.send(new SendMessageCommand({
    QueueUrl: filas.comandos, MessageGroupId: wallet.id, MessageDeduplicationId: id, MessageBody: JSON.stringify(comando),
  }));
  const prazo = Date.now() + 30000;
  let concluido = false;
  // Espera tanto o efeito financeiro quanto os quatro eventos da abertura e da aposta.
  while (Date.now() < prazo) {
    const eventos = await banco.em.fork().execute<{ quantidade: string }>(
      "select count(*)::text as quantidade from eventos_recebidos where payload->'data'->>'walletId' = ?", [wallet.id], "get",
    );
    if (eventos.quantidade === "4") { concluido = true; break; }
    await Bun.sleep(100);
  }
  verificar.ok(concluido, "Os consumidores não concluíram os eventos em 30 segundos");

  // Recupera a aposta SQS pela identidade externa e a reverte por HTTP usando o mesmo processador.
  const externa = await fetch(`${base}/providers/demonstracao/wagering/transactions/${id}`, { signal: AbortSignal.timeout(8000) });
  verificar.equal(externa.status, 200);
  const aposta = await externa.json();
  verificar.equal(aposta.status, "PROCESSED");
  verificar.equal(aposta.balance.amount, "20.00");
  const { idempotencyKey: _chave, ...dados } = comando.data;
  const idRefund = randomUUID();
  const reversao = await fetch(base + "/wagering/transactions", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idRefund },
    body: JSON.stringify({ ...dados, kind: "REFUND", externalTransactionId: idRefund, referenceExternalTransactionId: id }),
    signal: AbortSignal.timeout(8000),
  });
  verificar.equal(reversao.status, 200);
  const refund = await reversao.json();
  verificar.equal(refund.referenceTransactionId, aposta.transactionId);
  verificar.equal(refund.balance.amount, "100.00");

  // O GET por UUID continua mostrando o saldo da BET, mesmo depois da devolução.
  const interna = await fetch(`${base}/wagering/transactions/${aposta.transactionId}`, { signal: AbortSignal.timeout(8000) });
  verificar.equal(interna.status, 200);
  verificar.deepEqual(await interna.json(), aposta);
  const resposta = await fetch(base + "/wallets/" + wallet.id + "/reconciliation", {
    method: "POST", signal: AbortSignal.timeout(8000),
  });
  verificar.equal(resposta.status, 200);
  const resultado = await resposta.json();
  verificar.equal(resultado.consistent, true);
  verificar.equal(resultado.storedBalance.amount, "100.00");
  verificar.equal(resultado.checkedEntries, 3);
  console.log(JSON.stringify({ evento: "demonstracao_concluida", walletId: wallet.id, messageId: id,
    transactionId: aposta.transactionId, refundId: refund.transactionId, resultado }));
} finally {
  cliente.destroy();
  await banco.close();
}
