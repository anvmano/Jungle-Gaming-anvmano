import verificar from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeleteMessageCommand, DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { conectarPostgres } from "../src/infraestrutura/postgres";
import { criarClienteSqs, prepararFilas } from "../src/infraestrutura/filas";
import { Mensageria } from "../src/infraestrutura/mensageria";
import { ServicoFinanceiro } from "../src/aplicacao/servico-financeiro";
import { lerAbertura, lerTransacao } from "../src/aplicacao/contratos-financeiros";

// Isola banco e filas reais, preservando os recursos da demonstração.
const idTeste = randomUUID().replaceAll("-", "");
const nomeBanco = "jungle_sqs_" + idTeste;
const prefixo = idTeste + "-";
const urlAdmin = new URL(process.env.URL_BANCO_MIGRACOES ?? "");
const urlApp = new URL(process.env.URL_BANCO ?? "");
const administracao = await conectarPostgres(urlAdmin.href);
urlAdmin.pathname = nomeBanco;
urlApp.pathname = nomeBanco;
const cliente = criarClienteSqs();
let filas: Awaited<ReturnType<typeof prepararFilas>> | undefined;
let processo: ReturnType<typeof Bun.spawn> | undefined;
let bancoCriado = false;

// Limita esperas e indica a condição que não foi observada.
async function aguardar(condicao: () => Promise<boolean>, mensagem: string) {
  const prazo = Date.now() + 15000;
  while (Date.now() < prazo) {
    if (await condicao()) return;
    await Bun.sleep(50);
  }
  throw new Error(mensagem);
}

// Inicia o HTTP real com os mesmos dados usados pelo consumidor SQS.
async function iniciarHttp(enderecoSqs = process.env.URL_SQS, referenciasAtivas = false) {
  processo = Bun.spawn([process.execPath, "src/principal.ts"], {
    env: { ...process.env, PORTA: "3401", URL_BANCO: urlApp.href, URL_SQS: enderecoSqs, MENSAGERIA_ATIVA: "false", REFERENCIAS_ATIVAS: String(referenciasAtivas) },
    stdout: "ignore", stderr: "inherit",
  });
  await aguardar(async () => {
    if (processo?.exitCode !== null) throw new Error("O servidor HTTP encerrou durante a inicialização");
    return fetch("http://127.0.0.1:3401/health/live").then((resposta) => resposta.ok).catch(() => false);
  }, "O HTTP não inicializou");
}

// Submete a operação pelo contrato público, com a chave no cabeçalho.
async function enviarHttp(dados: Record<string, unknown>, chave: string, codigoEsperado = 200) {
  const resposta = await fetch("http://127.0.0.1:3401/wagering/transactions", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": chave },
    body: JSON.stringify(dados), signal: AbortSignal.timeout(8000),
  });
  verificar.equal(resposta.status, codigoEsperado);
  return resposta.json();
}

try {
  await administracao.em.execute(`CREATE DATABASE ${nomeBanco}`);
  bancoCriado = true;
  const migracoes = await conectarPostgres(urlAdmin.href);
  const aplicacao = await conectarPostgres(urlApp.href);
  try {
    await migracoes.getMigrator().up();
    filas = await prepararFilas(cliente, prefixo);
    // A segunda chamada comprova o provisionamento repetível.
    verificar.deepEqual(await prepararFilas(cliente, prefixo), filas);
    const financeiro = new ServicoFinanceiro(aplicacao);
    const consumidor = new Mensageria(aplicacao, financeiro, cliente, filas);
    const publicador = new Mensageria(aplicacao, financeiro, cliente, filas);
    const playerId = randomUUID();
    const wallet = await financeiro.abrir(lerAbertura({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }));
    const dados = { playerId, walletId: wallet.id, providerId: "provedor", externalTransactionId: "aposta",
      roundId: "rodada", gameId: "jogo", kind: "BET", money: { amount: "10.00", currency: "BRL" } };
    const envelope = { messageId: randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...dados, idempotencyKey: "aposta" } };

    // Usa deduplicationId novo para forçar a entrega pelo broker e testar a deduplicação no banco.
    async function enviarComando(corpo: unknown) {
      await cliente.send(new SendMessageCommand({
        QueueUrl: filas!.comandos, MessageBody: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
        MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID(),
      }));
    }

    await iniciarHttp();
    // A prontidão distingue SQS indisponível de um processo vivo e se recupera após reinício.
    verificar.equal((await fetch("http://127.0.0.1:3401/health/ready")).status, 200);
    processo!.kill();
    await processo!.exited;
    await iniciarHttp("http://127.0.0.1:1");
    verificar.equal((await fetch("http://127.0.0.1:3401/health/live")).status, 200);
    verificar.equal((await fetch("http://127.0.0.1:3401/health/ready")).status, 503);
    processo!.kill();
    await processo!.exited;
    await iniciarHttp();
    // Bloqueia novas conexões somente ao banco descartável e encerra a sessão da sonda.
    await migracoes.em.execute(`ALTER DATABASE ${nomeBanco} CONNECTION LIMIT 0`);
    await migracoes.em.execute("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and usename = 'jungle_app'");
    verificar.equal((await fetch("http://127.0.0.1:3401/health/live")).status, 200);
    verificar.equal((await fetch("http://127.0.0.1:3401/health/ready")).status, 503);
    await migracoes.em.execute(`ALTER DATABASE ${nomeBanco} CONNECTION LIMIT -1`);
    verificar.equal((await fetch("http://127.0.0.1:3401/health/ready")).status, 200);
    await enviarComando(envelope);
    const [respostaHttp] = await Promise.all([enviarHttp(dados, "aposta"), consumidor.consumirComando()]);
    verificar.equal(respostaHttp.status, "PROCESSED");
    await enviarComando(envelope);
    verificar.equal(await consumidor.consumirComando(), true);
    const inbox = await aplicacao.em.execute<{ quantidade: string }>(
      "select count(*)::text as quantidade from inbox_messages where processed_at is not null", [], "get",
    );
    verificar.equal(inbox.quantidade, "1");
    verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), "90.00");

    // Reutilização de messageId com novo conteúdo vai à DLQ sem aplicar a nova operação.
    await enviarComando({ ...envelope, data: { ...envelope.data, externalTransactionId: "colisao", idempotencyKey: "colisao" } });
    await consumidor.consumirComando();
    const conflito = await cliente.send(new ReceiveMessageCommand({ QueueUrl: filas.dlqComandos, WaitTimeSeconds: 2 }));
    verificar.equal(conflito.Messages?.length, 1);
    await cliente.send(new DeleteMessageCommand({ QueueUrl: filas.dlqComandos, ReceiptHandle: conflito.Messages![0].ReceiptHandle }));
    verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), "90.00");

    // A validação encaminha JSON malformado e REFUND sem referência obrigatória.
    for (const invalida of ["{", { ...envelope, messageId: randomUUID(), data: { ...envelope.data, kind: "REFUND" } }]) {
      await enviarComando(invalida);
      await consumidor.consumirComando();
    }
    // Confirma a mensagem anterior para liberar as seguintes do mesmo grupo FIFO.
    const invalidas = await cliente.send(new ReceiveMessageCommand({ QueueUrl: filas.dlqComandos, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
    verificar.equal(invalidas.Messages?.length, 2);

    // A rejeição de negócio confirma a inbox e remove a entrega normalmente.
    const rejeitada = { ...envelope, messageId: randomUUID(), data: {
      ...envelope.data, externalTransactionId: "sem-saldo", idempotencyKey: "sem-saldo", money: { amount: "999.00", currency: "BRL" },
    } };
    await enviarComando(rejeitada);
    await consumidor.consumirComando();
    verificar.equal((await cliente.send(new ReceiveMessageCommand({ QueueUrl: filas.comandos, WaitTimeSeconds: 1 }))).Messages?.length ?? 0, 0);

    // Interrompe e reinicia o processo HTTP antes de qualquer publicação da outbox.
    const pendentes = await aplicacao.em.execute<{ quantidade: string }>(
      "select count(*)::text as quantidade from outbox_messages where published_at is null", [], "get",
    );
    verificar.equal(pendentes.quantidade, "5");
    processo!.kill();
    await processo!.exited;
    await iniciarHttp();
    verificar.deepEqual(await enviarHttp(dados, "aposta"), { ...respostaHttp, idempotentReplay: true });

    // Uma falha real de envio mantém o evento pendente com backoff registrado.
    const falho = new Mensageria(aplicacao, financeiro, cliente, { ...filas, eventos: filas.eventos + "-inexistente" });
    verificar.equal(await falho.publicarUm(), false);
    const tentativa = await aplicacao.em.execute<{ attempts: number; next_attempt_at: Date; published_at: Date | null }>(
      "select attempts, next_attempt_at, published_at from outbox_messages where attempts > 0", [], "get",
    );
    verificar.equal(tentativa.attempts, 1);
    verificar.ok(tentativa.next_attempt_at);
    verificar.equal(tentativa.published_at, null);
    await migracoes.em.execute("update outbox_messages set next_attempt_at = now() where attempts > 0");

    // Dois publishers usam conexões transacionais distintas para drenar a outbox.
    await aguardar(async () => {
      await Promise.all([consumidor.publicarUm(), publicador.publicarUm()]);
      const linha = await aplicacao.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from outbox_messages where published_at is null", [], "get");
      return linha.quantidade === "0";
    }, "Os publishers não drenaram a outbox");
    await aguardar(async () => {
      await consumidor.consumirEvento();
      const linha = await aplicacao.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from eventos_recebidos", [], "get");
      return linha.quantidade === "5";
    }, "O consumidor não persistiu os eventos");

    // O broker recebe novamente um eventId já confirmado e entrega-o ao consumidor.
    const evento = await aplicacao.em.execute<{ payload: Record<string, unknown> }>("select payload from outbox_messages limit 1", [], "get");
    await cliente.send(new SendMessageCommand({ QueueUrl: filas.eventos, MessageBody: JSON.stringify(evento.payload) }));
    verificar.equal(await consumidor.consumirEvento(), true);
    const total = await aplicacao.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from eventos_recebidos", [], "get");
    verificar.equal(total.quantidade, "5");

    // Impede a última escrita financeira e comprova que inbox e outbox também sofrem rollback.
    await migracoes.em.execute(`
      create function falhar_comando_teste() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'WagerTransactionProcessed' and exists (
          select 1 from wager_transactions where id::text = new.payload->'data'->>'transactionId'
            and external_transaction_id = 'rollback'
        ) then raise exception 'Falha injetada'; end if;
        return new;
      end; $$;
      create trigger falhar_comando_teste before insert on outbox_messages
        for each row execute function falhar_comando_teste();
    `);
    const rollback = { ...envelope, messageId: randomUUID(), data: { ...envelope.data, externalTransactionId: "rollback", idempotencyKey: "rollback" } };
    await enviarComando(rollback);
    await consumidor.consumirComando();
    const parcial = await aplicacao.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from inbox_messages where message_id = ?", [rollback.messageId], "get");
    verificar.equal(parcial.quantidade, "0");
    verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), "90.00");
    verificar.equal(await publicador.publicarUm(), false);
    await migracoes.em.execute("drop trigger falhar_comando_teste on outbox_messages; drop function falhar_comando_teste()");
    await aguardar(async () => {
      await consumidor.consumirComando();
      const linha = await aplicacao.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from inbox_messages where message_id = ? and processed_at is not null", [rollback.messageId], "get");
      return linha.quantidade === "1";
    }, "O comando não foi recuperado depois do rollback");
    verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), "80.00");

    // Falha depois do envio e antes da marcação força a reentrega real de um evento.
    await migracoes.em.execute(`
      create function falhar_confirmacao_teste() returns trigger language plpgsql as $$
      begin
        if new.published_at is not null then raise exception 'Falha após envio'; end if;
        return new;
      end; $$;
      create trigger falhar_confirmacao_teste before update on outbox_messages
        for each row execute function falhar_confirmacao_teste();
    `);
    await verificar.rejects(publicador.publicarUm());
    await migracoes.em.execute("drop trigger falhar_confirmacao_teste on outbox_messages; drop function falhar_confirmacao_teste()");
    await Promise.all([publicador.publicarUm(), consumidor.publicarUm()]);
    // Foram enviados três eventos para duas identidades novas.
    for (let indice = 0; indice < 3; indice++) verificar.equal(await consumidor.consumirEvento(), true);
    const final = await aplicacao.em.execute<{ quantidade: string }>("select count(*)::text as quantidade from eventos_recebidos", [], "get");
    verificar.equal(final.quantidade, "7");
    verificar.equal((await financeiro.reconciliar(wallet.id)).consistent, true);
    verificar.equal((await financeiro.reconciliar(wallet.id)).checkedEntries, 3);
    // Um WIN recebido pelos dois canais também produz um único crédito.
    const premio = { ...dados, kind: "WIN", externalTransactionId: "premio", money: { amount: "5.00", currency: "BRL" } };
    const comandoPremio = { ...envelope, messageId: randomUUID(), data: { ...premio, idempotencyKey: "premio" } };
    await enviarComando(comandoPremio);
    await Promise.all([enviarHttp(premio, "premio"), consumidor.consumirComando()]);
    verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), "85.00");
    await Promise.all([publicador.publicarUm(), consumidor.publicarUm()]);
    for (let indice = 0; indice < 2; indice++) verificar.equal(await consumidor.consumirEvento(), true);
    verificar.equal((await financeiro.reconciliar(wallet.id)).consistent, true);
    verificar.equal((await financeiro.reconciliar(wallet.id)).checkedEntries, 4);

    // Cada nova operação dependente chega por HTTP e SQS e produz um único efeito confirmado.
    for (const [kind, externa, referencia, amount, saldo] of [
      ["REFUND", "refund", "aposta", "10.00", "95.00"],
      ["ROLLBACK", "rollback-refund", "refund", "10.00", "85.00"],
      ["WIN", "win-referencia", "aposta", "5.00", "90.00"],
      ["ROLLBACK", "rollback-win", "win-referencia", "5.00", "85.00"],
    ]) {
      const dependente = { ...dados, kind, externalTransactionId: externa,
        referenceExternalTransactionId: referencia, money: { amount, currency: "BRL" } };
      const comando = { ...envelope, messageId: randomUUID(), data: { ...dependente, idempotencyKey: externa } };
      await enviarComando(comando);
      const [resposta] = await Promise.all([enviarHttp(dependente, externa), consumidor.consumirComando()]);
      verificar.equal(resposta.status, "PROCESSED");
      verificar.ok(resposta.referenceTransactionId);
      verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), saldo);
      await enviarComando(comando);
      verificar.equal(await consumidor.consumirComando(), true);
      verificar.equal((await enviarHttp(dependente, externa)).idempotentReplay, true);
      await Promise.all([publicador.publicarUm(), consumidor.publicarUm()]);
      for (let indice = 0; indice < 2; indice++) verificar.equal(await consumidor.consumirEvento(), true);
      verificar.equal(await publicador.publicarUm(), false);
      verificar.equal((await financeiro.reconciliar(wallet.id)).consistent, true);
    }
    verificar.equal((await financeiro.reconciliar(wallet.id)).checkedEntries, 8);
    // A retomada das pendências abaixo ocorre após o ack; não depende de reentrega do comando SQS.

    // Reversão já consumida é rejeição de negócio: confirma inbox, preserva saldo e publica rejeição.
    const duplicada = { ...dados, kind: "ROLLBACK", externalTransactionId: "reversao-repetida", referenceExternalTransactionId: "aposta" };
    await enviarComando({ ...envelope, messageId: randomUUID(), data: { ...duplicada, idempotencyKey: "reversao-repetida" } });
    verificar.equal(await consumidor.consumirComando(), true);
    verificar.equal((await enviarHttp(duplicada, "reversao-repetida", 422)).failureCode, "ALREADY_REVERSED");
    verificar.equal(await publicador.publicarUm(), true);
    verificar.equal(await consumidor.consumirEvento(), true);

    // O ack da referência ausente só ocorre após sua persistência; o evento de espera não vai à DLQ.
    const pendente = { ...dados, kind: "REFUND", externalTransactionId: "pendente", referenceExternalTransactionId: "ainda-ausente" };
    const mensagemPendente = { ...envelope, messageId: randomUUID(), data: { ...pendente, idempotencyKey: "pendente" } };
    await enviarComando(mensagemPendente);
    verificar.equal(await consumidor.consumirComando(), true);
    const respostaPendente = await enviarHttp(pendente, "pendente", 202);
    verificar.equal(respostaPendente.status, "PENDING_REFERENCE");
    verificar.equal(respostaPendente.idempotentReplay, true);
    verificar.equal(respostaPendente.balance, undefined);
    const inboxPendente = await aplicacao.em.execute<{ processed_at: Date }>(
      "select processed_at from inbox_messages where message_id = ?", [mensagemPendente.messageId], "get");
    verificar.ok(inboxPendente.processed_at);
    verificar.equal(await publicador.publicarUm(), true);
    verificar.equal(await consumidor.consumirEvento(), true);
    verificar.equal(await publicador.publicarUm(), false);
    verificar.equal(await consumidor.consumirComando(), false);
    verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), "85.00");
    verificar.equal((await financeiro.reconciliar(wallet.id)).checkedEntries, 8);

    // A referência chega depois do ack; um processo reiniciado com worker conclui a operação persistida.
    const referenciaTardia = { ...dados, externalTransactionId: "ainda-ausente" };
    await enviarHttp(referenciaTardia, "ainda-ausente");
    processo!.kill();
    await processo!.exited;
    await iniciarHttp(process.env.URL_SQS, true);
    await aguardar(async () => (await aplicacao.em.execute<{ status: string }>(
      "select status from wager_transactions where id = ?", [respostaPendente.transactionId], "get")).status === "PROCESSED",
      "O worker não retomou a pendência aceita por SQS");
    const concluida = await enviarHttp(pendente, "pendente");
    verificar.equal(concluida.transactionId, respostaPendente.transactionId);
    verificar.equal(concluida.idempotentReplay, true);
    verificar.equal(concluida.balance.amount, "85.00");
    for (let indice = 0; indice < 4; indice++) {
      verificar.equal(await publicador.publicarUm(), true);
      verificar.equal(await consumidor.consumirEvento(), true);
    }
    verificar.equal(await publicador.publicarUm(), false);
    verificar.equal((await financeiro.reconciliar(wallet.id)).checkedEntries, 10);

    // Um prazo curto gravado pelo consumidor é respeitado pelo worker de outro processo.
    const financeiroCurto = new ServicoFinanceiro(aplicacao, {
      atrasoInicialMs: 50, atrasoMaximoMs: 200, ttlMs: 150, intervaloConsultaMs: 20,
    });
    const consumidorCurto = new Mensageria(aplicacao, financeiroCurto, cliente, filas);
    const expiravel = { ...dados, kind: "REFUND", externalTransactionId: "expiravel", referenceExternalTransactionId: "nunca-chega" };
    await enviarComando({ ...envelope, messageId: randomUUID(), data: { ...expiravel, idempotencyKey: "expiravel" } });
    verificar.equal(await consumidorCurto.consumirComando(), true);
    await aguardar(async () => (await aplicacao.em.execute<{ status: string }>(
      "select status from wager_transactions where external_transaction_id = 'expiravel'", [], "get")).status === "REJECTED",
      "O worker não expirou a pendência SQS");
    verificar.equal((await enviarHttp(expiravel, "expiravel", 422)).failureCode, "REFERENCE_EXPIRED");
    for (let indice = 0; indice < 2; indice++) {
      verificar.equal(await publicador.publicarUm(), true);
      verificar.equal(await consumidor.consumirEvento(), true);
    }
    verificar.equal(await publicador.publicarUm(), false);
    verificar.equal((await financeiro.consultarWallet(wallet.id)).balance.toString(), "85.00");
    verificar.equal((await financeiro.reconciliar(wallet.id)).checkedEntries, 10);
    verificar.equal((await financeiro.reconciliar(wallet.id)).consistent, true);
  } finally {
    if (processo) { processo.kill(); await processo.exited; }
    await aplicacao.close();
    await migracoes.close();
  }
} finally {
  // Remove exclusivamente os recursos criados por este teste.
  try {
    if (filas) for (const url of Object.values(filas)) await cliente.send(new DeleteQueueCommand({ QueueUrl: url }));
    if (bancoCriado) await administracao.em.execute(`DROP DATABASE ${nomeBanco}`);
  } finally {
    cliente.destroy();
    await administracao.close();
  }
}
console.log("Mensageria aprovada: HTTP/SQS, inbox atômica, DLQ, retry, reinício e publishers com deduplicação persistente");
