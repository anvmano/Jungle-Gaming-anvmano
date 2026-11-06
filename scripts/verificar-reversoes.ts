import verificar from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarPostgres } from "../src/infraestrutura/postgres";

// Isola dados e processos para não modificar as wallets utilizadas pelo Postman.
const nomeBanco = "jungle_reversoes_" + randomUUID().replaceAll("-", "");
const urlAdmin = new URL(process.env.URL_BANCO_MIGRACOES ?? "");
const urlApp = new URL(process.env.URL_BANCO ?? "");
const administracao = await conectarPostgres(urlAdmin.href);
urlAdmin.pathname = nomeBanco;
urlApp.pathname = nomeBanco;
const portas = [3501, 3502, 3503];
const processos: ReturnType<typeof Bun.spawn>[] = [];
const valor = (amount: string, currency = "BRL") => ({ amount, currency });
let bancoCriado = false;

// Mantém limites de tempo e expõe a resposta HTTP para verificar os contratos reais.
async function chamar(porta: number, rota: string, corpo?: object, chave?: string) {
  const resposta = await fetch(`http://127.0.0.1:${porta}${rota}`, {
    method: corpo === undefined ? "GET" : "POST", body: corpo === undefined ? undefined : JSON.stringify(corpo),
    headers: { "Content-Type": "application/json", ...(chave ? { "Idempotency-Key": chave } : {}) },
    signal: AbortSignal.timeout(10000),
  });
  return { codigo: resposta.status, dados: await resposta.json() };
}

// Aguarda condições observáveis, inclusive a disputa de locks no PostgreSQL.
async function aguardar(condicao: () => Promise<boolean>, mensagem: string, prazo = 5000) {
  const limite = Date.now() + prazo;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await Bun.sleep(25);
  }
  throw new Error(mensagem);
}

try {
  await administracao.em.execute(`CREATE DATABASE ${nomeBanco}`);
  bancoCriado = true;
  const migracoes = await conectarPostgres(urlAdmin.href);
  const aplicacao = await conectarPostgres(urlApp.href);
  try {
    await migracoes.getMigrator().up();
    for (const porta of portas) processos.push(Bun.spawn([process.execPath, "src/principal.ts"], {
      env: { ...process.env, URL_BANCO: urlApp.href, PORTA: String(porta), MENSAGERIA_ATIVA: "false", REFERENCIAS_ATIVAS: "false" },
      stdout: "ignore", stderr: "inherit",
    }));
    await aguardar(async () => {
      if (processos.some((processo) => processo.exitCode !== null)) throw new Error("Uma réplica encerrou");
      return (await Promise.all(portas.map((porta) => chamar(porta, "/health/live").catch(() => null))))
        .every((resposta) => resposta?.codigo === 200);
    }, "As réplicas não iniciaram", 15000);

    // Abre uma carteira por cenário e prepara comandos com identidades únicas.
    async function abrir() {
      const playerId = randomUUID();
      const resposta = await chamar(portas[0], "/wallets", { playerId, initialBalance: valor("100.00") });
      verificar.equal(resposta.codigo, 201);
      return { playerId, walletId: resposta.dados.id as string };
    }
    function comando(wallet: Awaited<ReturnType<typeof abrir>>, kind: string, amount: string, referenceExternalTransactionId?: string) {
      const externalTransactionId: string = randomUUID();
      return { ...wallet, providerId: "provedor", externalTransactionId, kind, money: valor(amount),
        roundId: "rodada", gameId: "jogo", referenceExternalTransactionId };
    }
    const enviar = (dados: ReturnType<typeof comando>, indice = 0) =>
      chamar(portas[indice], "/wagering/transactions", dados, dados.externalTransactionId);

    // Reconcilia e confere a ausência de incrementos de versão ou ledger indevidos.
    async function conferir(walletId: string, saldo: string, lancamentos: number) {
      const carteira = await chamar(portas[2], `/wallets/${walletId}`);
      verificar.equal(carteira.dados.balance.amount, saldo);
      verificar.equal(carteira.dados.version, lancamentos);
      const resultado = await chamar(portas[2], `/wallets/${walletId}/reconciliation`, {});
      verificar.equal(resultado.dados.consistent, true);
      verificar.equal(resultado.dados.checkedEntries, lancamentos);
      verificar.equal(resultado.dados.calculatedBalance.amount, saldo);
    }

    // Executa todas as reversões permitidas, com prêmio diferente da BET e replay histórico.
    const wallet = await abrir();
    const bet = comando(wallet, "BET", "80.00");
    const aposta = await enviar(bet);
    verificar.equal(aposta.codigo, 200);
    const win = comando(wallet, "WIN", "30.00", bet.externalTransactionId);
    const premio = await enviar(win, 1);
    verificar.equal(premio.codigo, 200);
    verificar.equal(premio.dados.referenceTransactionId, aposta.dados.transactionId);
    const desfazerWin = comando(wallet, "ROLLBACK", "30.00", win.externalTransactionId);
    verificar.equal((await enviar(desfazerWin, 2)).dados.balance.amount, "20.00");
    const refund = comando(wallet, "REFUND", "80.00", bet.externalTransactionId);
    const devolucao = await enviar(refund);
    verificar.equal(devolucao.codigo, 200);
    const desfazerRefund = comando(wallet, "ROLLBACK", "80.00", refund.externalTransactionId);
    verificar.equal((await enviar(desfazerRefund, 1)).dados.balance.amount, "20.00");
    verificar.deepEqual((await enviar(refund, 2)).dados, { ...devolucao.dados, idempotentReplay: true });
    verificar.deepEqual((await enviar(win, 2)).dados, { ...premio.dados, idempotentReplay: true });
    verificar.equal((await enviar(comando(wallet, "ROLLBACK", "80.00", bet.externalTransactionId))).dados.failureCode, "ALREADY_REVERSED");
    const ledger = await chamar(portas[0], `/wallets/${wallet.walletId}/ledger`);
    verificar.deepEqual(ledger.dados.entries.map((entrada: { direction: string }) => entrada.direction),
      ["CREDIT", "DEBIT", "CREDIT", "DEBIT", "CREDIT", "DEBIT"]);
    await conferir(wallet.walletId, "20.00", 6);

    // Rejeições definitivas não consomem a reversão; uma nova identidade poderá concluir depois.
    const semSaldo = await abrir();
    const credito = comando(semSaldo, "WIN", "80.00");
    verificar.equal((await enviar(credito)).codigo, 200);
    verificar.equal((await enviar(comando(semSaldo, "BET", "150.00"))).codigo, 200);
    const tentativa = comando(semSaldo, "ROLLBACK", "80.00", credito.externalTransactionId);
    const rejeicao = await enviar(tentativa);
    verificar.equal(rejeicao.codigo, 422);
    verificar.equal(rejeicao.dados.failureCode, "REVERSAL_INSUFFICIENT_FUNDS");
    await conferir(semSaldo.walletId, "30.00", 3);
    verificar.equal((await enviar(comando(semSaldo, "WIN", "50.00"))).codigo, 200);
    verificar.deepEqual((await enviar(tentativa, 1)).dados, { ...rejeicao.dados, idempotentReplay: true });
    verificar.equal((await enviar(comando(semSaldo, "ROLLBACK", "80.00", credito.externalTransactionId), 2)).codigo, 200);
    await conferir(semSaldo.walletId, "0.00", 5);

    // Uma wallet nova permite testar divergências sem reversão anterior mascarar o resultado.
    const validacao = await abrir();
    const base = comando(validacao, "BET", "80.00");
    const original = await enviar(base);
    const referenciaInvalida = comando(validacao, "REFUND", "80.00", base.externalTransactionId);
    const outra = await abrir();
    for (const alteracao of [{ money: valor("79.99") }, { roundId: "outra" }, outra]) {
      const resposta = await enviar({ ...referenciaInvalida, ...alteracao, externalTransactionId: randomUUID() });
      verificar.equal(resposta.codigo, 422);
      verificar.equal(resposta.dados.failureCode, "REFERENCE_MISMATCH");
    }
    verificar.equal((await enviar({ ...referenciaInvalida, externalTransactionId: randomUUID(), money: valor("80.00", "USD") })).dados.failureCode, "CURRENCY_MISMATCH");
    verificar.equal((await enviar({ ...referenciaInvalida, externalTransactionId: randomUUID(), playerId: outra.playerId })).dados.failureCode, "WALLET_PLAYER_MISMATCH");
    const betRejeitada = comando(validacao, "BET", "90.00");
    verificar.equal((await enviar(betRejeitada)).codigo, 422);
    verificar.equal((await enviar(comando(validacao, "REFUND", "90.00", betRejeitada.externalTransactionId))).dados.failureCode, "REFERENCE_NOT_PROCESSED");
    const loss = comando(validacao, "LOSS", "0.00");
    verificar.equal((await enviar(loss)).codigo, 200);
    verificar.equal((await enviar(comando(validacao, "ROLLBACK", "1.00", loss.externalTransactionId))).dados.failureCode, "REFERENCE_MISMATCH");
    await conferir(validacao.walletId, "20.00", 2);
    await conferir(outra.walletId, "100.00", 1);

    // Referência ausente é durável; replay não duplica evento e não renova vencimento.
    const pendente = comando(validacao, "WIN", "5.00", "referencia-ausente");
    const espera = await enviar(pendente);
    verificar.equal(espera.codigo, 202);
    verificar.equal(espera.dados.status, "PENDING_REFERENCE");
    verificar.equal(espera.dados.balance, undefined);
    const lerPrazo = () => aplicacao.em.execute<{ expira_referencia_em: Date; proxima_tentativa_referencia: Date }>(
      "select expira_referencia_em, proxima_tentativa_referencia from wager_transactions where id = ?", [espera.dados.transactionId], "get");
    const prazo = await lerPrazo();
    verificar.ok(prazo.expira_referencia_em > prazo.proxima_tentativa_referencia);
    verificar.deepEqual((await enviar(pendente, 2)).dados, { ...espera.dados, idempotentReplay: true });
    verificar.deepEqual(await lerPrazo(), prazo);
    const eventosPendentes = await aplicacao.em.execute<{ event_type: string }[]>(
      "select event_type from outbox_messages where payload->'data'->>'transactionId' = ?", [espera.dados.transactionId]);
    verificar.deepEqual(eventosPendentes, [{ event_type: "WagerTransactionPendingReference" }]);
    const conflito = await enviar({ ...pendente, referenceExternalTransactionId: base.externalTransactionId });
    verificar.equal(conflito.codigo, 409);
    verificar.equal(conflito.dados.failureCode, "IDEMPOTENCY_CONFLICT");
    await conferir(validacao.walletId, "20.00", 2);

    // Barreira SQL comprova disputa real entre três processos, sem serialização artificial no cliente.
    for (const tipos of [["REFUND", "REFUND", "REFUND"], ["ROLLBACK", "ROLLBACK", "ROLLBACK"], ["REFUND", "ROLLBACK", "REFUND"]]) {
      const concorrente = await abrir();
      const apostaBase = comando(concorrente, "BET", "80.00");
      verificar.equal((await enviar(apostaBase)).codigo, 200);
      const comandos = tipos.map((kind) => comando(concorrente, kind, "80.00", apostaBase.externalTransactionId));
      let respostas: Promise<PromiseSettledResult<Awaited<ReturnType<typeof enviar>>>[]> | undefined;
      try {
        await migracoes.em.fork().transactional(async (banco) => {
          await banco.execute("select id from wallets where id = ? for no key update", [concorrente.walletId]);
          respostas = Promise.allSettled(comandos.map((dados, indice) => enviar(dados, indice)));
          await aguardar(async () => {
            await banco.execute("select pg_stat_clear_snapshot()");
            const linha = await banco.execute<{ quantidade: string }>(`select count(*)::text as quantidade from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock' and query like '%for no key update%'
                and pid <> pg_backend_pid()`, [], "get");
            return linha.quantidade === "3";
          }, "Três reversões não chegaram ao lock", 3000);
          verificar.equal((await enviar(comando(outra, "LOSS", "0.00"))).codigo, 200);
        });
      } finally { if (respostas) await respostas; }
      verificar.ok(respostas);
      const resultados = (await respostas).map((resultado) => {
        if (resultado.status === "rejected") throw resultado.reason;
        return resultado.value;
      });
      verificar.deepEqual(resultados.map((resultado) => resultado.codigo).sort(), [200, 422, 422]);
      verificar.ok(resultados.filter((resultado) => resultado.codigo === 422).every((resultado) => resultado.dados.failureCode === "ALREADY_REVERSED"));
      const indice = resultados.findIndex((resultado) => resultado.codigo === 200);
      const repetidas = await Promise.all(Array.from({ length: 30 }, (_, numero) => enviar(comandos[indice], numero % 3)));
      verificar.ok(repetidas.every((resposta) => resposta.codigo === 200 && resposta.dados.idempotentReplay));
      verificar.ok(repetidas.every((resposta) => resposta.dados.transactionId === resultados[indice].dados.transactionId));
      await conferir(concorrente.walletId, "100.00", 3);
    }

    // A conta restrita não pode aplicar uma referência incompatível nem contornar a unicidade.
    const sqlReversao = `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
      payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at,
      processed_at, balance, reference_external_transaction_id, reference_transaction_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, 'jogo', ?, ?, ?, 'PROCESSED', now(), now(), 2000, ?, ?)`;
    const sqlDados = (alteracao: Record<string, unknown> = {}) => {
      const dados = { providerId: "provedor", walletId: validacao.walletId, playerId: validacao.playerId,
        roundId: "rodada", kind: "REFUND", amount: "8000", currency: "BRL",
        externa: base.externalTransactionId, interna: original.dados.transactionId, ...alteracao };
      return [randomUUID(), dados.providerId, randomUUID(), randomUUID(), "a".repeat(64), dados.walletId,
        dados.playerId, dados.roundId, dados.kind, dados.amount, dados.currency, dados.externa, dados.interna];
    };
    for (const alteracao of [{ interna: null }, { externa: "errada" }, { providerId: "outro" }, { walletId: outra.walletId },
      { playerId: outra.playerId }, { roundId: "outra" }, { currency: "USD" }, { amount: "7900" },
      { externa: loss.externalTransactionId, interna: (await enviar(loss)).dados.transactionId }]) {
      await verificar.rejects(aplicacao.em.execute(sqlReversao, sqlDados(alteracao)), { code: "23514" });
    }
    verificar.equal((await enviar(referenciaInvalida)).codigo, 200);
    await verificar.rejects(aplicacao.em.execute(sqlReversao, sqlDados()), { code: "23505" });
    await verificar.rejects(aplicacao.em.execute(sqlReversao, sqlDados({ kind: "ROLLBACK" })), { code: "23505" });
    await conferir(validacao.walletId, "100.00", 3);

    // Uma falha no último evento desfaz também a reserva de reversão e permite retry idêntico.
    await migracoes.em.execute(`create function falhar_reversao_teste() returns trigger language plpgsql as $$
      begin if new.event_type = 'WagerTransactionProcessed' and exists (select 1 from wager_transactions
        where id::text = new.payload->'data'->>'transactionId' and external_transaction_id = 'falha-reversao')
        then raise exception 'Falha injetada'; end if; return new; end; $$;
      create trigger falhar_reversao_teste before insert on outbox_messages for each row execute function falhar_reversao_teste();`);
    const falha = { ...comando(validacao, "ROLLBACK", "80.00", referenciaInvalida.externalTransactionId), externalTransactionId: "falha-reversao" };
    verificar.equal((await enviar(falha)).codigo, 500);
    await conferir(validacao.walletId, "100.00", 3);
    verificar.equal((await aplicacao.em.execute<{ total: string }>(
      "select count(*)::text as total from wager_transactions where external_transaction_id = 'falha-reversao'", [], "get")).total, "0");
    await migracoes.em.execute("drop trigger falhar_reversao_teste on outbox_messages; drop function falhar_reversao_teste()");
    verificar.equal((await enviar(falha, 1)).codigo, 200);
    await conferir(validacao.walletId, "20.00", 4);
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
console.log("Reversões aprovadas: referências, replay, pendência durável, constraints, três processos e rollback atômico");
