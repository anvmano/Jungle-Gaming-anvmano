import verificar from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarPostgres } from "../src/infraestrutura/postgres";

// Cria um banco descartável e três processos independentes com a conta restrita.
const enderecoMigracoes = process.env.URL_BANCO_MIGRACOES;
const enderecoAplicacao = process.env.URL_BANCO;
if (!enderecoMigracoes || !enderecoAplicacao) throw new Error("Informe as duas URLs do PostgreSQL");
const nomeBanco = "jungle_fluxo_" + randomUUID().replaceAll("-", "");
const urlMigracoes = new URL(enderecoMigracoes);
const urlAplicacao = new URL(enderecoAplicacao);
urlMigracoes.pathname = nomeBanco;
urlAplicacao.pathname = nomeBanco;
const administracao = await conectarPostgres(enderecoMigracoes);
const portas = [3301, 3302, 3303];
const processos: ReturnType<typeof Bun.spawn>[] = [];

// Faz requisições com limite de espera e deixa os testes conferir o status do contrato.
async function chamar(porta: number, rota: string, corpo?: object, chave?: string) {
  const resposta = await fetch("http://127.0.0.1:" + porta + rota, {
    method: corpo === undefined ? "GET" : "POST",
    headers: corpo === undefined ? undefined : { "Content-Type": "application/json", ...(chave ? { "Idempotency-Key": chave } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(8000),
  });
  return { codigo: resposta.status, dados: await resposta.json() };
}

// Aguarda uma condição observável em vez de presumir que o processo já chegou ao ponto esperado.
async function aguardar(condicao: () => Promise<boolean>, mensagem: string, prazo = 3000) {
  const limite = Date.now() + prazo;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await Bun.sleep(25);
  }
  throw new Error(mensagem);
}

// Reutiliza o formato monetário público nas asserções.
const valor = (amount: string) => ({ amount, currency: "BRL" });
let bancoCriado = false;

try {
  // Apenas o banco gerado por esta execução será removido no final.
  await administracao.em.execute(`CREATE DATABASE ${nomeBanco}`);
  bancoCriado = true;
  const orm = await conectarPostgres(urlMigracoes.href);
  try {
    await orm.getMigrator().up();
    for (const porta of portas) {
      processos.push(Bun.spawn([process.execPath, "src/principal.ts"], {
        env: { ...process.env, URL_BANCO: urlAplicacao.href, PORTA: String(porta), MENSAGERIA_ATIVA: "false", REFERENCIAS_ATIVAS: "false" },
        stdout: "ignore", stderr: "inherit",
      }));
    }
    await aguardar(async () => {
      if (processos.some((processo) => processo.exitCode !== null)) throw new Error("Uma réplica encerrou durante a inicialização");
      const estados = await Promise.all(portas.map((porta) => chamar(porta, "/health/live").catch(() => null)));
      return estados.every((estado) => estado?.codigo === 200);
    }, "As três réplicas não ficaram disponíveis", 15000);

    // Abre uma wallet com crédito e comprova que saldo inicial zero não gera lançamento.
    const playerId = randomUUID();
    const abertura = await chamar(portas[0], "/wallets", { playerId, initialBalance: valor("100.00") });
    verificar.equal(abertura.codigo, 201);
    const walletId: string = abertura.dados.id;
    const rotaWallet = "/wallets/" + walletId;
    const rotaLedger = rotaWallet + "/ledger";
    const rotaBet = "/wagering/transactions";
    verificar.equal((await chamar(portas[0], "/wallets", { playerId, initialBalance: valor("0.00") })).codigo, 409);
    const vazia = await chamar(portas[0], "/wallets", { playerId: randomUUID(), initialBalance: valor("0.00") });
    verificar.equal(vazia.codigo, 201);
    verificar.deepEqual((await chamar(portas[2], "/wallets/" + vazia.dados.id + "/ledger")).dados.entries, []);
    const dadosBet = (externalTransactionId: string, amount: string) => ({
      playerId, walletId, providerId: "provedor-teste", externalTransactionId, roundId: "rodada", gameId: "jogo",
      kind: "BET", money: valor(amount),
    });
    verificar.equal((await chamar(portas[0], rotaBet, dadosBet("sem-chave", "1.00"))).codigo, 400);
    verificar.equal((await chamar(portas[0], rotaBet, { ...dadosBet("tipo-invalido", "1.00"), kind: "OPENING" }, "tipo-invalido")).codigo, 400);

    // Prende a wallet até o PostgreSQL confirmar que ambas as requisições estão esperando pelo lock.
    const apostas = [dadosBet("aposta-a", "80.00"), dadosBet("aposta-b", "80.00")];
    let respostas: Promise<PromiseSettledResult<Awaited<ReturnType<typeof chamar>>>[]> | undefined;
    try {
      await orm.em.fork().transactional(async (banco) => {
        await banco.execute("select id from wallets where id = ? for no key update", [walletId]);
        respostas = Promise.allSettled(apostas.map((dados, indice) => chamar(portas[indice], rotaBet, dados, dados.externalTransactionId)));
        await aguardar(async () => {
          // O PostgreSQL pode reutilizar a visão de atividade durante a transação da barreira.
          await banco.execute("select pg_stat_clear_snapshot()");
          const fila = await banco.execute<{ quantidade: string }>(`
            select count(*)::text as quantidade from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query like '%for no key update%' and pid <> pg_backend_pid()
          `, [], "get");
          return fila.quantidade === "2";
        }, "O PostgreSQL não observou as duas apostas disputando a wallet");
        // Outra wallet conclui uma operação enquanto esta permanece bloqueada.
        const independente = await chamar(portas[2], rotaBet, {
          ...dadosBet("independente", "0.00"), playerId: vazia.dados.playerId, walletId: vazia.dados.id, kind: "LOSS",
        }, "independente");
        verificar.equal(independente.codigo, 200);
      });
    } finally {
      // Consome as respostas mesmo se o teste da barreira falhar.
      if (respostas) await respostas;
    }
    if (!respostas) throw new Error("As apostas não foram iniciadas");
    const resultados = (await respostas).map((resultado) => {
      if (resultado.status === "rejected") throw resultado.reason;
      return resultado.value;
    });
    verificar.deepEqual(resultados.map((resultado) => resultado.codigo).sort(), [200, 422]);
    const vencedor = resultados.findIndex((resultado) => resultado.codigo === 200);
    const rejeitada = resultados[1 - vencedor].dados;
    verificar.equal(resultados[vencedor].dados.status, "PROCESSED");
    verificar.equal(rejeitada.status, "REJECTED");
    verificar.equal(rejeitada.failureCode, "INSUFFICIENT_FUNDS");
    verificar.deepEqual((await chamar(portas[2], rotaWallet)).dados, { id: walletId, playerId, balance: valor("20.00"), version: 2 });

    // Lê as duas páginas e confirma que houve exatamente um crédito e um débito.
    const pagina = (await chamar(portas[2], rotaLedger + "?limit=1")).dados;
    verificar.equal(pagina.entries.length, 1);
    verificar.equal(pagina.entries[0].direction, "CREDIT");
    const seguinte = (await chamar(portas[2], rotaLedger + "?cursor=" + pagina.nextCursor)).dados;
    verificar.equal(seguinte.entries.length, 1);
    verificar.equal(seguinte.entries[0].direction, "DEBIT");
    verificar.equal(seguinte.nextCursor, null);
    verificar.equal((await chamar(portas[2], rotaLedger + "?cursor=invalido!")).codigo, 400);
    const conciliacao = (await chamar(portas[2], rotaWallet + "/reconciliation", {})).dados;
    verificar.deepEqual(conciliacao, { walletId, storedBalance: valor("20.00"), calculatedBalance: valor("20.00"),
      difference: valor("0.00"), consistent: true, checkedEntries: 2 });

    // Uma aposta posterior muda o saldo atual, mas não o resultado histórico das duas primeiras.
    verificar.equal((await chamar(portas[2], rotaBet, dadosBet("posterior", "1.00"), "posterior")).codigo, 200);
    for (const [indice, aposta] of apostas.entries()) {
      const { money, ...campos } = aposta;
      const repetida = await chamar(portas[2], rotaBet, { money: { currency: money.currency, amount: money.amount }, ...campos }, aposta.externalTransactionId);
      verificar.equal(repetida.codigo, resultados[indice].codigo);
      verificar.deepEqual(repetida.dados, { ...resultados[indice].dados, idempotentReplay: true });
    }
    verificar.equal((await chamar(portas[2], rotaBet, dadosBet("outra", "1.00"), apostas[0].externalTransactionId)).dados.failureCode, "IDEMPOTENCY_CONFLICT");
    verificar.equal((await chamar(portas[2], rotaBet, apostas[0], "chave-diferente")).dados.failureCode, "EXTERNAL_ID_CONFLICT");

    // Faz a última escrita falhar depois de saldo, ledger, primeiro evento e resultado já terem sido gravados.
    await orm.em.execute(`
      create function falhar_evento_de_teste() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'WagerTransactionProcessed' and exists (
          select 1 from wager_transactions
          where id::text = new.payload->'data'->>'transactionId' and external_transaction_id = 'forcar-rollback'
        ) then
          raise exception 'Falha injetada no teste';
        end if;
        return new;
      end;
      $$;
      create trigger falhar_evento_de_teste before insert on outbox_messages
        for each row execute function falhar_evento_de_teste();
    `);
    const antes = await orm.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from outbox_messages", [], "get");
    verificar.equal(antes.quantidade, "8");
    verificar.equal((await chamar(portas[1], rotaBet, dadosBet("forcar-rollback", "1.00"), "rollback")).codigo, 500);
    const depois = await orm.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from outbox_messages", [], "get");
    verificar.deepEqual(depois, antes);
    const parcial = await orm.em.execute<{ quantidade: string }>(
      "select count(*)::text as quantidade from wager_transactions where external_transaction_id = 'forcar-rollback'", [], "get",
    );
    verificar.equal(parcial.quantidade, "0");
    verificar.equal((await chamar(portas[2], rotaWallet)).dados.version, 3);
    const final = (await chamar(portas[2], rotaWallet + "/reconciliation", {})).dados;
    verificar.deepEqual(final, { walletId, storedBalance: valor("19.00"), calculatedBalance: valor("19.00"),
      difference: valor("0.00"), consistent: true, checkedEntries: 3 });

    // Distribui reenvios idênticos entre as três réplicas e confere a identidade persistida.
    const dadosReenvio = dadosBet("aposta-reenviada", "10.00");
    const reenvios = await Promise.all(Array.from({ length: 51 }, (_, indice) =>
      chamar(portas[indice % portas.length], rotaBet, dadosReenvio, "aposta-reenviada"),
    ));
    verificar.ok(reenvios.every(({ codigo, dados }) => codigo === 200 && dados.status === "PROCESSED"));
    verificar.equal(reenvios.filter(({ dados }) => dados.idempotentReplay === false).length, 1);
    verificar.equal(new Set(reenvios.map(({ dados }) => dados.transactionId)).size, 1);
    verificar.ok(reenvios.every(({ dados }) => dados.balance.amount === "9.00"));

    // O prêmio é aplicado uma vez mesmo quando reentregue por outra réplica.
    const premio = { ...dadosBet("premio", "7.50"), kind: "WIN" };
    const premios = await Promise.all(portas.map((porta) => chamar(porta, rotaBet, premio, "premio")));
    verificar.ok(premios.every(({ codigo, dados }) => codigo === 200 && dados.balance.amount === "16.50"));
    verificar.equal(premios.filter(({ dados }) => dados.idempotentReplay === false).length, 1);
    verificar.equal(new Set(premios.map(({ dados }) => dados.transactionId)).size, 1);

    // LOSS exige zero e produz apenas o evento de transação processada.
    const perda = { ...dadosBet("perda", "0.00"), kind: "LOSS" };
    const perdas = await Promise.all(portas.map((porta) => chamar(porta, rotaBet, perda, "perda")));
    verificar.ok(perdas.every(({ codigo, dados }) => codigo === 200 && dados.balance.amount === "16.50"));
    verificar.equal(perdas.filter(({ dados }) => dados.idempotentReplay === false).length, 1);
    verificar.equal(new Set(perdas.map(({ dados }) => dados.transactionId)).size, 1);
    const eventos = await orm.em.execute<{ event_type: string }[]>(
      "select event_type from outbox_messages where payload->'data'->>'transactionId' = ?", [perdas[0].dados.transactionId],
    );
    verificar.deepEqual(eventos, [{ event_type: "WagerTransactionProcessed" }]);
    verificar.equal((await chamar(portas[0], rotaBet, { ...perda, money: valor("1.00") }, "perda-invalida")).codigo, 400);
    verificar.equal((await chamar(portas[0], rotaBet, { ...premio, money: valor("0.00") }, "premio-zero")).codigo, 400);
    verificar.equal((await chamar(portas[0], rotaBet, { ...premio, referenceExternalTransactionId: "aposta-a" }, "premio-referencia")).dados.failureCode, "EXTERNAL_ID_CONFLICT");

    // Identidade global e identidade por provedor continuam protegidas entre wallets.
    const outraWallet = { ...premio, walletId: vazia.dados.id, playerId: vazia.dados.playerId };
    const chaveEmOutraWallet = await chamar(portas[0], rotaBet, outraWallet, "premio");
    verificar.equal(chaveEmOutraWallet.codigo, 409);
    verificar.equal(chaveEmOutraWallet.dados.failureCode, "IDEMPOTENCY_CONFLICT");
    const externaEmOutraWallet = await chamar(portas[1], rotaBet, outraWallet, "premio-outra-wallet");
    verificar.equal(externaEmOutraWallet.codigo, 409);
    verificar.equal(externaEmOutraWallet.dados.failureCode, "EXTERNAL_ID_CONFLICT");
    verificar.deepEqual((await chamar(portas[2], "/wallets/" + vazia.dados.id)).dados.balance, valor("0.00"));

    // Creditar além de BIGINT produz rejeição persistida sem alterar a wallet.
    const noLimite = await chamar(portas[0], "/wallets", { playerId: randomUUID(), initialBalance: valor("92233720368547758.07") });
    verificar.equal(noLimite.codigo, 201);
    const excedente = { ...premio, externalTransactionId: "excedente", walletId: noLimite.dados.id, playerId: noLimite.dados.playerId, money: valor("0.01") };
    const excesso = await chamar(portas[1], rotaBet, excedente, "excedente");
    verificar.equal(excesso.codigo, 422);
    verificar.equal(excesso.dados.failureCode, "BALANCE_LIMIT_EXCEEDED");
    verificar.deepEqual((await chamar(portas[2], rotaBet, excedente, "excedente")).dados,
      { ...excesso.dados, idempotentReplay: true });
    verificar.equal((await chamar(portas[2], "/wallets/" + noLimite.dados.id)).dados.version, 1);

    // Apenas o débito e o crédito únicos alteram a versão e acrescentam lançamentos.
    verificar.equal((await chamar(portas[2], rotaWallet)).dados.version, 5);
    const conciliacaoCompleta = (await chamar(portas[2], rotaWallet + "/reconciliation", {})).dados;
    verificar.deepEqual(conciliacaoCompleta, { walletId, storedBalance: valor("16.50"), calculatedBalance: valor("16.50"),
      difference: valor("0.00"), consistent: true, checkedEntries: 5 });
    // Uma divergência artificial é sinalizada e contada, sem correção silenciosa.
    await orm.em.execute("update wallets set balance = 1 where id = ?", [vazia.dados.id]);
    verificar.equal((await chamar(portas[2], "/wallets/" + vazia.dados.id + "/reconciliation", {})).dados.consistent, false);
    const metricas = await fetch("http://127.0.0.1:" + portas[2] + "/metrics").then((resposta) => resposta.text());
    verificar.ok(metricas.includes("jungle_reconciliation_divergences_total 1"));
    verificar.equal((await chamar(portas[2], "/wallets/" + vazia.dados.id)).dados.balance.amount, "0.01");
    await orm.em.execute("update wallets set balance = 0 where id = ?", [vazia.dados.id]);
    verificar.equal((await chamar(portas[2], "/wallets/" + vazia.dados.id + "/reconciliation", {})).dados.consistent, true);
  } finally {
    for (const processo of processos) processo.kill();
    await Promise.all(processos.map((processo) => processo.exited));
    await orm.close();
  }
} finally {
  // Fecha as réplicas antes de remover o banco que elas compartilham.
  try {
    if (bancoCriado) await administracao.em.execute(`DROP DATABASE ${nomeBanco}`);
  } finally {
    await administracao.close();
  }
}

console.log("Concorrência aprovada: três processos, BET/WIN/LOSS, replay persistente, reconciliação e rollback atômico");
