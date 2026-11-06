import verificar from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Money } from "../src/dominio/money";
import { Wallet } from "../src/dominio/wallet";
import { gravarMoney } from "../src/infraestrutura/mapear-money";
import { gravarWallet, lerWallet, type RegistroWallet } from "../src/infraestrutura/mapear-wallet";
import { conectarPostgres } from "../src/infraestrutura/postgres";

// Cria um banco exclusivo por execução para testar reversão sem tocar nos dados existentes.
const enderecoMigracoes = process.env.URL_BANCO_MIGRACOES;
const enderecoAplicacao = process.env.URL_BANCO;
if (!enderecoMigracoes || !enderecoAplicacao) throw new Error("Informe as duas URLs do PostgreSQL");
const nomeBanco = "jungle_teste_" + randomUUID().replaceAll("-", "");
const urlMigracoes = new URL(enderecoMigracoes);
const urlAplicacao = new URL(enderecoAplicacao);
urlMigracoes.pathname = nomeBanco;
urlAplicacao.pathname = nomeBanco;
const administracao = await conectarPostgres(enderecoMigracoes);
let bancoCriado = false;

try {
  // O nome gerado contém somente letras, números e sublinhados.
  await administracao.em.execute(`CREATE DATABASE ${nomeBanco}`);
  bancoCriado = true;
  const migracoes = await conectarPostgres(urlMigracoes.href);
  try {
    const executor = migracoes.getMigrator();
    verificar.equal((await executor.up()).length, 3);
    verificar.equal((await executor.down({ to: 0 })).length, 3);
    const resultado = await migracoes.em.execute<{ tabela: string | null }>(
      "select to_regclass('public.wallets')::text as tabela", [], "get",
    );
    verificar.equal(resultado.tabela, null);
    verificar.equal((await executor.up()).length, 3);

    // Usa as credenciais reais da aplicação para comprovar os limites dos privilégios.
    const aplicacao = await conectarPostgres(urlAplicacao.href);
    try {
      const db = aplicacao.em;
      const agora = new Date();
      const money = Money.from({ amount: "90071992547409.93", currency: "BRL" });
      const wallet = gravarWallet(Wallet.open(randomUUID(), randomUUID(), money, agora));
      const inserirWallet = "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?,?,?,?,?,?,?)";
      await db.execute(inserirWallet, [wallet.id, wallet.player_id, wallet.currency, wallet.balance, wallet.version, wallet.created_at, wallet.updated_at]);
      const registro = await db.execute<RegistroWallet>(
        "select id, player_id, currency, balance, version, created_at, updated_at from wallets where id = ?", [wallet.id], "get",
      );
      verificar.deepEqual(gravarWallet(lerWallet(registro)), wallet);
      await verificar.rejects(db.execute(inserirWallet, [randomUUID(), wallet.player_id, "BRL", "0", 1, agora, agora]), { code: "23505" });
      await verificar.rejects(db.execute("update wallets set balance = -1 where id = ?", [wallet.id]), { code: "23514" });
      await verificar.rejects(db.execute("create table teste_ddl (id integer)"), { code: "42501" });

      // Confere as duas chaves de unicidade e protege a identidade ainda no estado pendente.
      const idTransacao = randomUUID();
      const hash = "a".repeat(64);
      const inserirTransacao = "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at) values (?,'provedor',?,?,?, ?,?,'rodada','jogo','OPENING',?,'BRL','PENDING',?)";
      const dados = [hash, wallet.id, wallet.player_id, gravarMoney(money), agora];
      await db.execute(inserirTransacao, [idTransacao, "externa", "chave", ...dados]);
      await verificar.rejects(db.execute(inserirTransacao, [randomUUID(), "outra", "chave", ...dados]), { code: "23505" });
      await verificar.rejects(db.execute(inserirTransacao, [randomUUID(), "externa", "outra", ...dados]), { code: "23505" });
      await verificar.rejects(migracoes.em.execute("update wager_transactions set idempotency_key = 'alterada'"), { code: "23514" });
      await db.execute("update wager_transactions set status = 'PROCESSED', balance = ?, processed_at = ? where id = ?", [gravarMoney(money), agora, idTransacao]);
      await verificar.rejects(db.execute("update wager_transactions set balance = 0"), { code: "23514" });

      // Testa aritmética, unicidade, imutabilidade e proibição de esvaziar o ledger.
      const inserirLedger = "insert into wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, created_at) values (?,?,?,'BRL','CREDIT',?,0,?,?)";
      const centavos = gravarMoney(money);
      await verificar.rejects(db.execute(inserirLedger, [randomUUID(), wallet.id, idTransacao, centavos, "1", agora]), { code: "23514" });
      await db.execute(inserirLedger, [randomUUID(), wallet.id, idTransacao, centavos, centavos, agora]);
      await verificar.rejects(db.execute(inserirLedger, [randomUUID(), wallet.id, idTransacao, centavos, centavos, agora]), { code: "23505" });
      await verificar.rejects(db.execute("update wallet_ledger_entries set amount = 1"), { code: "42501" });
      await verificar.rejects(db.execute("delete from wallet_ledger_entries"), { code: "42501" });
      await verificar.rejects(db.execute("truncate wallet_ledger_entries"), { code: "42501" });
      await verificar.rejects(migracoes.em.execute("update wallet_ledger_entries set amount = 1"), { code: "23514" });
      await verificar.rejects(migracoes.em.execute("delete from wallet_ledger_entries"), { code: "23514" });

      // Comprova que a mesma entrega só pode ser registrada uma vez por consumidor.
      const inserirInbox = "insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('consumidor','mensagem',?,?)";
      await db.execute(inserirInbox, [hash, agora]);
      await verificar.rejects(db.execute(inserirInbox, [hash, agora]), { code: "23505" });
    } finally {
      await aplicacao.close();
    }
  } finally {
    await migracoes.close();
  }
} finally {
  // Remove apenas o banco criado por esta execução e fecha a conexão administrativa.
  try {
    if (bancoCriado) await administracao.em.execute(`DROP DATABASE ${nomeBanco}`);
  } finally {
    await administracao.close();
  }
}

console.log("Proteções aprovadas: migração, reversão, reaplicação, constraints e privilégios");
