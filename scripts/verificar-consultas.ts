import verificar from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarPostgres } from "../src/infraestrutura/postgres";
import { ServicoFinanceiro } from "../src/aplicacao/servico-financeiro";

// O banco descartável permite testar estados de infraestrutura sem tocar na demonstração.
const nomeBanco = "jungle_consultas_" + randomUUID().replaceAll("-", "");
const urlAdmin = new URL(process.env.URL_BANCO_MIGRACOES ?? "");
const urlApp = new URL(process.env.URL_BANCO ?? "");
const administracao = await conectarPostgres(urlAdmin.href);
urlAdmin.pathname = nomeBanco;
urlApp.pathname = nomeBanco;
const portas = [3701, 3702, 3703];
const processos: ReturnType<typeof Bun.spawn>[] = [];
let bancoCriado = false;

// Exercita rotas reais, incluindo a codificação dos identificadores externos.
async function chamar(rota: string, corpo?: object, chave?: string, indice = 0) {
  const resposta = await fetch(`http://127.0.0.1:${portas[indice]}${rota}`, {
    method: corpo === undefined ? "GET" : "POST", body: corpo === undefined ? undefined : JSON.stringify(corpo),
    headers: { "Content-Type": "application/json", ...(chave ? { "Idempotency-Key": chave } : {}) },
    signal: AbortSignal.timeout(10000),
  });
  return { codigo: resposta.status, dados: await resposta.json() };
}

// Espera um efeito observável e falha com prazo limitado se uma réplica não responder.
async function aguardar(condicao: () => Promise<boolean>) {
  const prazo = Date.now() + 15000;
  while (Date.now() < prazo) {
    if (await condicao()) return;
    await Bun.sleep(25);
  }
  throw new Error("A condição da consulta não foi atingida");
}

try {
  await administracao.em.execute(`CREATE DATABASE ${nomeBanco}`);
  bancoCriado = true;
  const migracoes = await conectarPostgres(urlAdmin.href);
  const aplicacao = await conectarPostgres(urlApp.href);
  const financeiro = new ServicoFinanceiro(aplicacao);
  try {
    await migracoes.getMigrator().up();
    for (const porta of portas) processos.push(Bun.spawn([process.execPath, "src/principal.ts"], {
      env: { ...process.env, URL_BANCO: urlApp.href, PORTA: String(porta), MENSAGERIA_ATIVA: "false", REFERENCIAS_ATIVAS: "false" },
      stdout: "ignore", stderr: "inherit",
    }));
    await aguardar(async () => (await Promise.all(portas.map((_, indice) =>
      chamar("/health/live", undefined, undefined, indice).catch(() => null)))).every((resposta) => resposta?.codigo === 200));

    // Consulta por ambas as identidades em réplicas diferentes e recusa vazamento de campos internos.
    async function consultar(transactionId: string, providerId: string, externalTransactionId: string) {
      const interna = await chamar("/wagering/transactions/" + transactionId, undefined, undefined, 1);
      const externa = await chamar(`/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`,
        undefined, undefined, 2);
      verificar.equal(interna.codigo, 200);
      verificar.deepEqual(externa, interna);
      for (const campo of ["idempotencyKey", "payloadHash", "tentativas_referencia", "expira_referencia_em", "idempotentReplay"]) {
        verificar.equal(campo in interna.dados, false);
      }
      verificar.equal(interna.dados.transactionId, transactionId);
      verificar.equal(new Date(interna.dados.createdAt).toISOString(), interna.dados.createdAt);
      return interna.dados;
    }

    // Cria a wallet e comandos para demonstrar saldo histórico distinto do saldo corrente.
    const playerId = randomUUID();
    const abertura = await chamar("/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
    verificar.equal(abertura.codigo, 201);
    const walletId = abertura.dados.id as string;
    function comando(kind: string, amount: string, referenceExternalTransactionId?: string) {
      return { providerId: "provedor", externalTransactionId: randomUUID() as string, walletId, playerId,
        roundId: "rodada", gameId: "jogo", kind, money: { amount, currency: "BRL" }, referenceExternalTransactionId };
    }
    const enviar = (dados: ReturnType<typeof comando>) => chamar("/wagering/transactions", dados, dados.providerId + ":" + dados.externalTransactionId);
    const bet = comando("BET", "80.00");
    const aposta = await enviar(bet);
    verificar.equal(aposta.codigo, 200);
    const win = comando("WIN", "30.00", bet.externalTransactionId);
    const premio = await enviar(win);
    verificar.equal(premio.codigo, 200);
    const historico = await consultar(aposta.dados.transactionId, bet.providerId, bet.externalTransactionId);
    verificar.equal(historico.balance.amount, "20.00");
    verificar.deepEqual(historico.money, bet.money);
    verificar.equal(historico.kind, "BET");
    verificar.equal(historico.walletId, walletId);
    verificar.equal(historico.playerId, playerId);
    verificar.equal(historico.roundId, bet.roundId);
    verificar.equal(historico.gameId, bet.gameId);
    verificar.equal(historico.status, "PROCESSED");
    verificar.ok(historico.processedAt);
    const ganho = await consultar(premio.dados.transactionId, win.providerId, win.externalTransactionId);
    verificar.equal(ganho.referenceTransactionId, aposta.dados.transactionId);
    verificar.equal(ganho.referenceExternalTransactionId, bet.externalTransactionId);
    verificar.equal(ganho.balance.amount, "50.00");

    // A consulta de uma rejeição é HTTP 200 e preserva as moedas da solicitação e do saldo separadamente.
    const invalida = { ...comando("BET", "1.00"), money: { amount: "1.00", currency: "USD" } };
    const rejeitada = await enviar(invalida);
    verificar.equal(rejeitada.codigo, 422);
    const rejeicao = await consultar(rejeitada.dados.transactionId, invalida.providerId, invalida.externalTransactionId);
    verificar.equal(rejeicao.failureCode, "CURRENCY_MISMATCH");
    verificar.deepEqual(rejeicao.balance, { amount: "50.00", currency: "BRL" });
    verificar.deepEqual(rejeicao.money, invalida.money);

    // OPENING é consultável pelo ID do ledger; LOSS permanece auditável sem criar lançamento.
    const ledger = await chamar(`/wallets/${walletId}/ledger`);
    const inicial = await consultar(ledger.dados.entries[0].transactionId, "__jungle_internal__", walletId);
    verificar.equal(inicial.kind, "OPENING");
    verificar.equal(inicial.balance.amount, "100.00");
    const perda = comando("LOSS", "0.00");
    const perdaAceita = await enviar(perda);
    verificar.equal((await consultar(perdaAceita.dados.transactionId, perda.providerId, perda.externalTransactionId)).kind, "LOSS");

    // Leituras não alteram TTL, tentativas, outbox, versão ou ledger, mesmo com a referência já disponível.
    const refund = comando("REFUND", "10.00", "bet-tardia");
    const espera = await enviar(refund);
    verificar.equal(espera.codigo, 202);
    const pendente = await consultar(espera.dados.transactionId, refund.providerId, refund.externalTransactionId);
    verificar.equal(pendente.status, "PENDING_REFERENCE");
    for (const campo of ["balance", "processedAt", "failureCode", "referenceTransactionId"]) verificar.equal(campo in pendente, false);
    verificar.equal((await enviar({ ...comando("BET", "10.00"), externalTransactionId: "bet-tardia" })).codigo, 200);
    const antes = await aplicacao.em.execute("select * from wager_transactions where id = ?", [espera.dados.transactionId]);
    const eventosAntes = await aplicacao.em.execute("select count(*) from outbox_messages");
    for (let leitura = 0; leitura < 3; leitura++) verificar.deepEqual(
      await consultar(espera.dados.transactionId, refund.providerId, refund.externalTransactionId), pendente);
    verificar.deepEqual(await aplicacao.em.execute("select * from wager_transactions where id = ?", [espera.dados.transactionId]), antes);
    verificar.deepEqual(await aplicacao.em.execute("select count(*) from outbox_messages"), eventosAntes);
    await aguardar(async () => { await financeiro.reprocessarPendencia();
      return (await chamar("/wagering/transactions/" + espera.dados.transactionId)).dados.status === "PROCESSED"; });
    const concluida = await consultar(espera.dados.transactionId, refund.providerId, refund.externalTransactionId);
    verificar.equal(concluida.balance.amount, "50.00");
    verificar.ok(concluida.referenceTransactionId);

    // Identidades externas são literais e isoladas por provedor, inclusive caracteres reservados de URL/SQL.
    const especial = { ...comando("LOSS", "0.00"), providerId: "Provedor á", externalTransactionId: "Id/?:' OR 1=1 --" };
    const primeira = await enviar(especial);
    verificar.equal(primeira.codigo, 200);
    const outra = { ...especial, providerId: "outro" };
    const segunda = await enviar(outra);
    verificar.equal(segunda.codigo, 200);
    verificar.notEqual(primeira.dados.transactionId, segunda.dados.transactionId);
    await consultar(primeira.dados.transactionId, especial.providerId, especial.externalTransactionId);
    await consultar(segunda.dados.transactionId, outra.providerId, outra.externalTransactionId);

    // Estados internos também são legíveis: fixture SQL simula uma falha permanente já auditada.
    const idFalha = randomUUID();
    await aplicacao.em.execute(`insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
      values (?, 'infraestrutura', 'falha', ?, ?, ?, ?, 'rodada', 'jogo', 'LOSS', 0, 'BRL', 'PENDING', now())`,
    [idFalha, idFalha, "a".repeat(64), walletId, playerId]);
    verificar.equal((await consultar(idFalha, "infraestrutura", "falha")).status, "PENDING");
    await aplicacao.em.execute("update wager_transactions set status = 'FAILED', failure_code = 'FALHA_TESTE', processed_at = now() where id = ?", [idFalha]);
    const falha = await consultar(idFalha, "infraestrutura", "falha");
    verificar.equal(falha.status, "FAILED");
    verificar.equal(falha.failureCode, "FALHA_TESTE");
    verificar.equal("balance" in falha, false);

    // Distingue entrada malformada de ausência; preserva escopo e sensibilidade a maiúsculas.
    for (const rota of ["/wagering/transactions/invalido", "/providers/%20invalido/wagering/transactions/id",
      "/providers/valido/wagering/transactions/" + "a".repeat(129), "/providers/valido/wagering/transactions/%09"]) {
      verificar.equal((await chamar(rota)).codigo, 400);
    }
    for (const rota of ["/wagering/transactions/" + randomUUID(), `/providers/ausente/wagering/transactions/${bet.externalTransactionId}`,
      `/providers/Provedor/wagering/transactions/${bet.externalTransactionId}`]) verificar.equal((await chamar(rota)).codigo, 404);
    verificar.deepEqual((await chamar("/wagering/transactions/" + aposta.dados.transactionId.toUpperCase())).dados, historico);

    // A reconciliação final cobre todas as operações e as leituras entre réplicas sem efeitos financeiros.
    const resultado = await chamar(`/wallets/${walletId}/reconciliation`, {});
    verificar.equal(resultado.dados.consistent, true);
    verificar.equal(resultado.dados.checkedEntries, 5);
    verificar.equal(resultado.dados.storedBalance.amount, "50.00");
    verificar.equal((await chamar(`/wallets/${walletId}`)).dados.version, 5);
  } finally {
    for (const processo of processos) processo.kill();
    await Promise.all(processos.map((processo) => processo.exited));
    await aplicacao.close();
    await migracoes.close();
  }
} finally {
  try { if (bancoCriado) await administracao.em.execute(`DROP DATABASE ${nomeBanco}`); }
  finally { await administracao.close(); }
}
console.log("Consultas aprovadas: duas identidades, estados, saldo histórico, moedas, isolamento por provedor e leituras sem efeitos");
