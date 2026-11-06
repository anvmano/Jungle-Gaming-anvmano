import verificar from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarPostgres } from "../src/infraestrutura/postgres";
import { ServicoFinanceiro } from "../src/aplicacao/servico-financeiro";
import { lerAbertura, lerTransacao } from "../src/aplicacao/contratos-financeiros";
import { lerConfiguracaoPendencias } from "../src/aplicacao/configuracao-pendencias";

// Isola o banco e as réplicas, preservando wallets e pendências da demonstração.
const nomeBanco = "jungle_pendencias_" + randomUUID().replaceAll("-", "");
const urlAdmin = new URL(process.env.URL_BANCO_MIGRACOES ?? "");
const urlApp = new URL(process.env.URL_BANCO ?? "");
const administracao = await conectarPostgres(urlAdmin.href);
urlAdmin.pathname = nomeBanco;
urlApp.pathname = nomeBanco;
const portas = [3601, 3602, 3603];
const processos: ReturnType<typeof Bun.spawn>[] = [];
const configuracao = lerConfiguracaoPendencias({ REFERENCIAS_ATRASO_INICIAL_MS: "50", REFERENCIAS_ATRASO_MAXIMO_MS: "200", REFERENCIAS_TTL_MS: "60000" });
const valor = (amount: string) => ({ amount, currency: "BRL" });
let bancoCriado = false;

// Observa estado real do PostgreSQL ou do HTTP, sem depender de uma pausa fixa para sincronizar.
async function aguardar(condicao: () => Promise<boolean>, mensagem: string, prazo = 10000) {
  const limite = Date.now() + prazo;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await Bun.sleep(15);
  }
  throw new Error(mensagem);
}

try {
  await administracao.em.execute(`CREATE DATABASE ${nomeBanco}`);
  bancoCriado = true;
  const migracoes = await conectarPostgres(urlAdmin.href);
  const aplicacao = await conectarPostgres(urlApp.href);
  const financeiro = new ServicoFinanceiro(aplicacao, configuracao);
  try {
    await migracoes.getMigrator().up();

    // Comandos novos mantêm sua identidade durante replays e reinícios.
    async function abrir() {
      const playerId = randomUUID();
      const wallet = await financeiro.abrir(lerAbertura({ playerId, initialBalance: valor("100.00") }));
      return { playerId, walletId: wallet.id };
    }
    function comando(wallet: Awaited<ReturnType<typeof abrir>>, kind: string, amount: string, referenceExternalTransactionId?: string) {
      const externalTransactionId: string = randomUUID();
      return { ...wallet, providerId: "provedor", externalTransactionId, kind, money: valor(amount),
        roundId: "rodada", gameId: "jogo", referenceExternalTransactionId };
    }
    const enviar = (dados: ReturnType<typeof comando>, servico = financeiro) =>
      servico.processar(lerTransacao(dados, dados.externalTransactionId));

    // Lê metadados e relógio na mesma consulta para verificar o agendamento exato sem relógio do host.
    async function estado(id: string) {
      const linha = await aplicacao.em.execute<{ status: string; failure_code: string | null; tentativas_referencia: number;
        expira_referencia_em: Date; proxima_tentativa_referencia: Date | null; agora: Date; devido: boolean }>(`
        select status, failure_code, tentativas_referencia, expira_referencia_em, proxima_tentativa_referencia,
          clock_timestamp() as agora,
          (proxima_tentativa_referencia <= clock_timestamp() or expira_referencia_em <= clock_timestamp()) as devido
        from wager_transactions where id = ?`, [id], "get");
      return { ...linha, agora: new Date(linha.agora), expira_referencia_em: new Date(linha.expira_referencia_em),
        proxima_tentativa_referencia: linha.proxima_tentativa_referencia && new Date(linha.proxima_tentativa_referencia) };
    }
    async function conferir(walletId: string, saldo: string, lancamentos: number) {
      const conciliacao = await financeiro.reconciliar(walletId);
      verificar.equal(conciliacao.consistent, true);
      verificar.equal(conciliacao.storedBalance.toString(), saldo);
      verificar.equal(conciliacao.checkedEntries, lancamentos);
      verificar.equal((await financeiro.consultarWallet(walletId)).version, lancamentos);
    }
    async function conferirEventos(id: string, tipos: string[]) {
      const eventos = await aplicacao.em.execute<{ event_type: string }[]>(
        "select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type", [id]);
      verificar.deepEqual(eventos.map((evento) => evento.event_type), [...tipos].sort());
    }

    // Exercita o backoff persistido e comprova que o evento inicial e o TTL não são renovados.
    const wallet = await abrir();
    const bet = comando(wallet, "BET", "80.00");
    const refund = comando(wallet, "REFUND", "80.00", bet.externalTransactionId);
    const pendente = await enviar(refund);
    verificar.equal(pendente.status, "PENDING_REFERENCE");
    const inicial = await estado(pendente.transactionId);
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      await aguardar(async () => (await estado(pendente.transactionId)).devido, "A pendência não ficou devida");
      const antes = (await estado(pendente.transactionId)).agora;
      verificar.equal(await financeiro.reprocessarPendencia(), true);
      const depois = await estado(pendente.transactionId);
      verificar.equal(depois.tentativas_referencia, tentativa);
      verificar.deepEqual(depois.expira_referencia_em, inicial.expira_referencia_em);
      const atraso = tentativa === 1 ? 100 : 200;
      verificar.ok(depois.proxima_tentativa_referencia!.getTime() >= antes.getTime() + atraso - 2);
      verificar.ok(depois.proxima_tentativa_referencia!.getTime() <= depois.agora.getTime() + atraso + 2);
      await enviar(refund);
      const replay = await estado(pendente.transactionId);
      verificar.deepEqual(replay.proxima_tentativa_referencia, depois.proxima_tentativa_referencia);
      verificar.equal(replay.tentativas_referencia, tentativa);
      await conferirEventos(pendente.transactionId, ["WagerTransactionPendingReference"]);
    }
    verificar.equal((await enviar(bet)).status, "PROCESSED");
    await aguardar(async () => (await estado(pendente.transactionId)).devido, "A retomada não ficou devida");
    await financeiro.reprocessarPendencia();
    verificar.equal((await enviar(refund)).status, "PROCESSED");
    await conferir(wallet.walletId, "100.00", 3);
    await conferirEventos(pendente.transactionId, ["WagerTransactionPendingReference", "WalletBalanceChanged", "WagerTransactionProcessed"]);

    // O TTL menor que o atraso limita o próximo agendamento e vence mesmo com referência tardia presente.
    const curto = new ServicoFinanceiro(aplicacao, { ...configuracao, ttlMs: 80, atrasoInicialMs: 1000, atrasoMaximoMs: 1000 });
    const expiradaWallet = await abrir();
    const tardia = comando(expiradaWallet, "BET", "80.00");
    const expirada = comando(expiradaWallet, "REFUND", "80.00", tardia.externalTransactionId);
    const aceiteExpirada = await enviar(expirada, curto);
    const prazo = await estado(aceiteExpirada.transactionId);
    verificar.deepEqual(prazo.proxima_tentativa_referencia, prazo.expira_referencia_em);
    await aguardar(async () => (await estado(aceiteExpirada.transactionId)).devido, "TTL não venceu");
    await enviar(tardia);
    await financeiro.reprocessarPendencia();
    const rejeicao = await enviar(expirada);
    verificar.equal(rejeicao.failureCode, "REFERENCE_EXPIRED");
    verificar.equal(rejeicao.balance?.toString(), "20.00");
    verificar.equal(await financeiro.reprocessarPendencia(), false);
    await conferirEventos(aceiteExpirada.transactionId, ["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    await conferir(expiradaWallet.walletId, "20.00", 2);

    // Um erro na última escrita desfaz resultado, saldo, ledger e incremento de tentativas.
    const falhaWallet = await abrir();
    const betFalha = comando(falhaWallet, "BET", "80.00");
    const refundFalha = { ...comando(falhaWallet, "REFUND", "80.00", betFalha.externalTransactionId), externalTransactionId: "falha-worker" };
    const aceiteFalha = await enviar(refundFalha);
    await enviar(betFalha);
    await aguardar(async () => (await estado(aceiteFalha.transactionId)).devido, "Falha não ficou devida");
    await migracoes.em.execute(`create sequence tentativas_worker_teste;
      grant usage, select on sequence tentativas_worker_teste to jungle_app;
      create function falhar_worker_teste() returns trigger language plpgsql as $$
      begin if new.event_type = 'WagerTransactionProcessed' and exists (select 1 from wager_transactions
        where id::text = new.payload->'data'->>'transactionId' and external_transaction_id = 'falha-worker')
        then perform nextval('tentativas_worker_teste'); raise exception 'Falha injetada'; end if; return new; end; $$;
      create trigger falhar_worker_teste before insert on outbox_messages for each row execute function falhar_worker_teste();`);
    await verificar.rejects(financeiro.reprocessarPendencia());
    verificar.equal((await estado(aceiteFalha.transactionId)).tentativas_referencia, 0);
    verificar.equal((await estado(aceiteFalha.transactionId)).status, "PENDING_REFERENCE");
    await conferir(falhaWallet.walletId, "20.00", 2);
    await conferirEventos(aceiteFalha.transactionId, ["WagerTransactionPendingReference"]);

    // Inicia três processos reais, cada um com worker independente do SQS.
    async function iniciar(indice: number, ativo = true) {
      processos[indice] = Bun.spawn([process.execPath, "src/principal.ts"], {
        env: { ...process.env, URL_BANCO: urlApp.href, PORTA: String(portas[indice]), MENSAGERIA_ATIVA: "false",
          REFERENCIAS_ATIVAS: String(ativo), REFERENCIAS_ATRASO_INICIAL_MS: "50", REFERENCIAS_ATRASO_MAXIMO_MS: "200",
          REFERENCIAS_TTL_MS: "60000", REFERENCIAS_INTERVALO_MS: "20" },
        stdout: "ignore", stderr: "ignore",
      });
      await aguardar(async () => {
        if (processos[indice].exitCode !== null) throw new Error("Worker encerrou inesperadamente");
        return fetch(`http://127.0.0.1:${portas[indice]}/health/live`).then((resposta) => resposta.ok).catch(() => false);
      }, "Worker não iniciou", 15000);
    }
    async function pararTodos() {
      for (const processo of processos) if (processo.exitCode === null) processo.kill();
      await Promise.all(processos.map((processo) => processo.exited));
    }
    async function enviarHttp(dados: ReturnType<typeof comando>, indice = 0) {
      const resposta = await fetch(`http://127.0.0.1:${portas[indice]}/wagering/transactions`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": dados.externalTransactionId },
        body: JSON.stringify(dados), signal: AbortSignal.timeout(8000),
      });
      return { codigo: resposta.status, dados: await resposta.json() };
    }
    await iniciar(0);
    // Observa uma tentativa bloqueada pelo trigger antes de retirar a falha, sem reiniciar o worker.
    await aguardar(async () => BigInt((await aplicacao.em.execute<{ last_value: string }>(
      "select last_value from tentativas_worker_teste", [], "get")).last_value) > 1n, "Worker não repetiu a tentativa falha");
    await migracoes.em.execute("drop trigger falhar_worker_teste on outbox_messages; drop function falhar_worker_teste(); drop sequence tentativas_worker_teste");
    await aguardar(async () => (await estado(aceiteFalha.transactionId)).status === "PROCESSED", "Worker não recuperou a falha");
    await conferir(falhaWallet.walletId, "100.00", 3);
    await conferirEventos(aceiteFalha.transactionId, ["WagerTransactionPendingReference", "WalletBalanceChanged", "WagerTransactionProcessed"]);
    await pararTodos();

    // Uma pendência aceita por HTTP sobrevive à morte do processo; replay não altera prazo nem identidade.
    await iniciar(0, false);
    const reinicioWallet = await abrir();
    const original = comando(reinicioWallet, "BET", "80.00");
    const dependente = comando(reinicioWallet, "WIN", "30.00", original.externalTransactionId);
    const aceitaHttp = await enviarHttp(dependente);
    verificar.equal(aceitaHttp.codigo, 202);
    const prazoReinicio = (await estado(aceitaHttp.dados.transactionId)).expira_referencia_em;
    await pararTodos();
    await enviar(original);
    await Promise.all(portas.map((_, indice) => iniciar(indice)));
    await aguardar(async () => (await estado(aceitaHttp.dados.transactionId)).status === "PROCESSED", "Reinício não retomou pendência");
    const replayHttp = await enviarHttp(dependente, 2);
    verificar.equal(replayHttp.codigo, 200);
    verificar.equal(replayHttp.dados.transactionId, aceitaHttp.dados.transactionId);
    verificar.equal(replayHttp.dados.idempotentReplay, true);
    verificar.deepEqual((await estado(aceitaHttp.dados.transactionId)).expira_referencia_em, prazoReinicio);
    await conferir(reinicioWallet.walletId, "50.00", 3);
    await conferirEventos(aceitaHttp.dados.transactionId, ["WagerTransactionPendingReference", "WalletBalanceChanged", "WagerTransactionProcessed"]);

    // Três workers disputam duas reversões distintas: só uma aplica e a outra rejeita.
    const disputa = await abrir();
    const originalDisputa = comando(disputa, "BET", "80.00");
    const devolucoes = [comando(disputa, "REFUND", "80.00", originalDisputa.externalTransactionId),
      comando(disputa, "ROLLBACK", "80.00", originalDisputa.externalTransactionId)];
    const aceites = await Promise.all(devolucoes.map((dados, indice) => enviarHttp(dados, indice)));
    verificar.ok(aceites.every((resposta) => resposta.codigo === 202));
    await enviar(originalDisputa);
    await aguardar(async () => (await Promise.all(aceites.map((aceite) => estado(aceite.dados.transactionId))))
      .every((linha) => linha.status !== "PENDING_REFERENCE"), "Reversões não terminaram");
    const resultados = await Promise.all(devolucoes.map((dados, indice) => enviarHttp(dados, indice)));
    verificar.deepEqual(resultados.map((resposta) => resposta.codigo).sort(), [200, 422]);
    verificar.equal(resultados.find((resposta) => resposta.codigo === 422)!.dados.failureCode, "ALREADY_REVERSED");
    for (const resultado of resultados) await conferirEventos(resultado.dados.transactionId,
      resultado.codigo === 200 ? ["WagerTransactionPendingReference", "WalletBalanceChanged", "WagerTransactionProcessed"]
        : ["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    await conferir(disputa.walletId, "100.00", 3);

    // Uma wallet bloqueada não impede outra de avançar; a pendência expira após a liberação do lock.
    await pararTodos();
    const bloqueada = await abrir();
    const livre = await abrir();
    const betLivre = comando(livre, "BET", "80.00");
    const esperaLivre = await enviar(comando(livre, "REFUND", "80.00", betLivre.externalTransactionId));
    const esperaBloqueada = await enviar(comando(bloqueada, "REFUND", "80.00", "nao-existe"), curto);
    await migracoes.em.fork().transactional(async (banco) => {
      await banco.execute("select id from wallets where id = ? for no key update", [bloqueada.walletId]);
      await Promise.all(portas.map((_, indice) => iniciar(indice)));
      await enviar(betLivre);
      await aguardar(async () => (await estado(esperaLivre.transactionId)).status === "PROCESSED", "Wallet livre foi bloqueada");
      await aguardar(async () => (await estado(esperaBloqueada.transactionId)).devido, "TTL bloqueado não venceu");
      verificar.equal((await estado(esperaBloqueada.transactionId)).status, "PENDING_REFERENCE");
    });
    await aguardar(async () => (await estado(esperaBloqueada.transactionId)).status === "REJECTED", "Expiração não foi retomada");
    verificar.equal((await estado(esperaBloqueada.transactionId)).failure_code, "REFERENCE_EXPIRED");
    await conferirEventos(esperaBloqueada.transactionId, ["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    await conferir(bloqueada.walletId, "100.00", 1);
    await conferir(livre.walletId, "100.00", 3);

    // A cadeia fora de ordem resolve REFUND antes de ROLLBACK; referência rejeitada encerra a dependente.
    const cadeia = await abrir();
    const betCadeia = comando(cadeia, "BET", "80.00");
    const refundCadeia = comando(cadeia, "REFUND", "80.00", betCadeia.externalTransactionId);
    const rollbackCadeia = comando(cadeia, "ROLLBACK", "80.00", refundCadeia.externalTransactionId);
    const aceiteRollback = await enviarHttp(rollbackCadeia);
    const aceiteRefund = await enviarHttp(refundCadeia, 1);
    await enviarHttp(betCadeia, 2);
    await aguardar(async () => (await estado(aceiteRollback.dados.transactionId)).status === "PROCESSED", "Cadeia não concluiu");
    verificar.equal((await estado(aceiteRefund.dados.transactionId)).status, "PROCESSED");
    await conferir(cadeia.walletId, "20.00", 4);
    const betInvalida = comando(cadeia, "BET", "90.00");
    const rejeitavel = comando(cadeia, "REFUND", "90.00", betInvalida.externalTransactionId);
    const aceiteRejeitavel = await enviarHttp(rejeitavel);
    verificar.equal((await enviarHttp(betInvalida)).codigo, 422);
    await aguardar(async () => (await estado(aceiteRejeitavel.dados.transactionId)).status === "REJECTED", "Referência rejeitada ficou pendente");
    verificar.equal((await estado(aceiteRejeitavel.dados.transactionId)).failure_code, "REFERENCE_NOT_PROCESSED");
    await conferir(cadeia.walletId, "20.00", 4);
    await pararTodos();
  } finally {
    for (const processo of processos) if (processo.exitCode === null) processo.kill();
    await Promise.all(processos.map((processo) => processo.exited));
    await aplicacao.close();
    await migracoes.close();
  }
} finally {
  try { if (bancoCriado) await administracao.em.execute(`DROP DATABASE ${nomeBanco}`); }
  finally { await administracao.close(); }
}
console.log("Pendências aprovadas: backoff persistido, TTL, replay, três workers, reinício, cadeias e rollback atômico");
