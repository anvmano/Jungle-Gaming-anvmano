import type { EntityManager } from "@mikro-orm/postgresql";
import type { Wallet } from "../dominio/wallet";
import { WagerTransaction, type DadosTransacao, type WagerTransactionState } from "../dominio/wager-transaction";
import type { WalletLedgerEntry, LedgerEntryState } from "../dominio/wallet-ledger-entry";
import type { OutboxMessage } from "../dominio/outbox-message";
import { gravarWallet, type RegistroWallet } from "./mapear-wallet";
import { gravarMoney, lerMoney } from "./mapear-money";

// Campos persistidos necessários para distinguir conflito de replay.
interface ResultadoPersistido {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  status: string;
  balance: string | null;
  currency: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
}

// Espelha o registro SQL para reconstruir referências sem revalidar sua criação.
interface RegistroTransacao {
  id: string; provider_id: string; external_transaction_id: string; idempotency_key: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string; kind: DadosTransacao["kind"];
  amount: string; currency: string; reference_external_transaction_id: string | null; reference_transaction_id: string | null;
  status: WagerTransactionState["status"]; balance: string | null; failure_code: string | null;
  created_at: Date; processed_at: Date | null;
  moeda_saldo?: string;
}

// Converte os campos monetários e as datas preservando o estado já confirmado no banco.
function lerTransacaoPersistida(linha: RegistroTransacao): WagerTransactionState {
  return WagerTransaction.rehydrate({
    id: linha.id, providerId: linha.provider_id, externalTransactionId: linha.external_transaction_id,
    idempotencyKey: linha.idempotency_key, payloadHash: linha.payload_hash, walletId: linha.wallet_id,
    playerId: linha.player_id, roundId: linha.round_id, gameId: linha.game_id, kind: linha.kind,
    money: lerMoney(linha.amount, linha.currency), referenceExternalTransactionId: linha.reference_external_transaction_id ?? undefined,
    referenceTransactionId: linha.reference_transaction_id ?? undefined, status: linha.status,
    balance: linha.balance === null ? undefined : lerMoney(linha.balance, linha.moeda_saldo ?? linha.currency),
    failureCode: linha.failure_code ?? undefined, createdAt: linha.created_at, processedAt: linha.processed_at ?? undefined,
  }).obterEstado();
}

// Centraliza SQL e conversões dentro do contexto fornecido pela unidade de trabalho.
export class RepositorioFinanceiro {
  // Cada instância recebe o contexto da consulta ou da transação corrente.
  constructor(private readonly banco: EntityManager) {}

  // Reserva a combinação jogador/moeda sem abortar a transação em caso de duplicata.
  async inserirWallet(wallet: Wallet): Promise<boolean> {
    const linha = gravarWallet(wallet);
    const linhas = await this.banco.execute<{ id: string }[]>(`
      insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?) on conflict (player_id, currency) do nothing returning id
    `, [linha.id, linha.player_id, linha.currency, linha.balance, linha.version, linha.created_at, linha.updated_at]);
    return linhas.length === 1;
  }

  // Serializa alterações de saldo sem bloquear o KEY SHARE adquirido pela chave estrangeira.
  buscarWallet(walletId: string, bloquear = false): Promise<RegistroWallet | undefined> {
    return this.banco.execute<RegistroWallet>(
      "select * from wallets where id = ?" + (bloquear ? " for no key update" : ""), [walletId], "get",
    );
  }

  // Reserva as duas identidades. O SELECT também evita uma violação de FK para wallet inexistente.
  async reservarTransacao(dados: DadosTransacao, ttlMs = 900000): Promise<boolean> {
    const linhas = await this.banco.execute<{ id: string }[]>(`
      insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at,
        reference_external_transaction_id, expira_referencia_em)
      select ?, ?, ?, ?, ?, id, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?,
        case when ?::text is not null then clock_timestamp() + ? * interval '1 millisecond' else null end
      from wallets where id = ?
      on conflict do nothing returning id
    `, [dados.id, dados.providerId, dados.externalTransactionId, dados.idempotencyKey, dados.payloadHash,
      dados.playerId, dados.roundId, dados.gameId, dados.kind, gravarMoney(dados.money), dados.money.currency,
      dados.createdAt, dados.referenceExternalTransactionId ?? null, dados.referenceExternalTransactionId ?? null, ttlMs, dados.walletId]);
    return linhas.length === 1;
  }

  // Lê o resultado confirmado após a disputa de unicidade, priorizando a Idempotency-Key.
  buscarResultado(dados: DadosTransacao): Promise<ResultadoPersistido | undefined> {
    return this.banco.execute<ResultadoPersistido>(`
      select t.id, t.idempotency_key, t.payload_hash, t.status, t.balance, w.currency, t.failure_code, t.reference_transaction_id
      from wager_transactions t join wallets w on w.id = t.wallet_id
      where t.idempotency_key = ? or (t.provider_id = ? and t.external_transaction_id = ?)
      order by (t.idempotency_key = ?) desc limit 1
    `, [dados.idempotencyKey, dados.providerId, dados.externalTransactionId, dados.idempotencyKey], "get");
  }

  // Consulta o estado confirmado e a moeda do saldo, inclusive em rejeições por CURRENCY_MISMATCH.
  async buscarTransacao(transactionId: string): Promise<WagerTransactionState | undefined> {
    const linha = await this.banco.execute<RegistroTransacao>(
      "select t.*, w.currency as moeda_saldo from wager_transactions t join wallets w on w.id = t.wallet_id where t.id = ?",
      [transactionId], "get",
    );
    return linha && lerTransacaoPersistida(linha);
  }

  // Busca pelo escopo do provedor sem bloquear uma wallet alheia em caso de incompatibilidade.
  async buscarReferencia(providerId: string, externalTransactionId: string): Promise<WagerTransactionState | undefined> {
    const linha = await this.banco.execute<RegistroTransacao>(
      `select t.*, w.currency as moeda_saldo from wager_transactions t join wallets w on w.id = t.wallet_id
       where t.provider_id = ? and t.external_transaction_id = ?`,
      [providerId, externalTransactionId], "get",
    );
    return linha && lerTransacaoPersistida(linha);
  }

  // A consulta ocorre depois do lock da wallet; o índice único também protege SQL direto.
  async buscarReversoes(referenceTransactionId: string): Promise<WagerTransactionState[]> {
    const linhas = await this.banco.execute<RegistroTransacao[]>(`
      select * from wager_transactions where reference_transaction_id = ?
        and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `, [referenceTransactionId]);
    return linhas.map(lerTransacaoPersistida);
  }

  // Persiste o saldo observado e a decisão final antes de confirmar a transação SQL.
  async salvarResultado(transacao: WagerTransaction, tentativas = 0, atrasoMs = 1000): Promise<void> {
    const estado = transacao.obterEstado();
    await this.banco.execute(
      `update wager_transactions set status = ?, balance = ?, failure_code = ?, processed_at = ?, reference_transaction_id = ?,
        tentativas_referencia = ?,
        proxima_tentativa_referencia = case when ? = 'PENDING_REFERENCE'
          then least(expira_referencia_em, clock_timestamp() + ? * interval '1 millisecond') else null end
        where id = ?`,
      [estado.status, estado.balance ? gravarMoney(estado.balance) : null, estado.failureCode ?? null, estado.processedAt ?? null,
        estado.referenceTransactionId ?? null, tentativas, estado.status, atrasoMs, estado.id],
    );
  }

  // Bloqueia primeiro a wallet, pulando as ocupadas; nunca adquire lock de transação antes dela.
  selecionarWalletPendente(): Promise<RegistroWallet | undefined> {
    return this.banco.execute<RegistroWallet>(`
      select w.* from wager_transactions t join wallets w on w.id = t.wallet_id
      where t.status = 'PENDING_REFERENCE'
        and (t.proxima_tentativa_referencia <= clock_timestamp() or t.expira_referencia_em <= clock_timestamp())
      order by least(t.proxima_tentativa_referencia, t.expira_referencia_em), t.id
      limit 1 for no key update of w skip locked
    `, [], "get");
  }

  // Relê a pendência em um novo snapshot depois do lock e decide o vencimento pelo relógio do banco.
  async buscarPendencia(walletId: string) {
    const linha = await this.banco.execute<RegistroTransacao & { tentativas_referencia: number; agora: Date; expirada: boolean }>(`
      select t.*, clock_timestamp() as agora, expira_referencia_em <= clock_timestamp() as expirada
      from wager_transactions t where wallet_id = ? and status = 'PENDING_REFERENCE'
        and (proxima_tentativa_referencia <= clock_timestamp() or expira_referencia_em <= clock_timestamp())
      order by least(proxima_tentativa_referencia, expira_referencia_em), id limit 1
    `, [walletId], "get");
    return linha && { estado: lerTransacaoPersistida(linha), tentativas: linha.tentativas_referencia,
      agora: new Date(linha.agora), expirada: linha.expirada };
  }

  // Persiste o saldo protegido pelo bloqueio adquirido na mesma transação.
  async atualizarWallet(wallet: Wallet): Promise<void> {
    const linha = gravarWallet(wallet);
    await this.banco.execute("update wallets set balance = ?, version = ?, updated_at = ? where id = ?",
      [linha.balance, linha.version, linha.updated_at, linha.id]);
  }

  // Registra a movimentação como lançamento imutável.
  async inserirLancamento(lancamento: WalletLedgerEntry): Promise<void> {
    const estado = lancamento.obterEstado();
    await this.banco.execute(`
      insert into wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [estado.id, estado.walletId, estado.transactionId, estado.money.currency, estado.direction,
      gravarMoney(estado.money), gravarMoney(estado.balanceBefore), gravarMoney(estado.balanceAfter), estado.createdAt]);
  }

  // Grava o evento na mesma transação do saldo e do ledger.
  async inserirEvento(mensagem: OutboxMessage): Promise<void> {
    const estado = mensagem.obterEstado();
    await this.banco.execute(`
      insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values (?, ?, ?, ?::jsonb, ?)
    `, [estado.id, estado.aggregateId, estado.eventType, JSON.stringify(estado.payload), estado.occurredAt]);
  }

  // Lê uma página em ordem de sequência, com uma linha extra para detectar a próxima página.
  async listarLedger(walletId: string, sequencia: string, limite: number) {
    const linhas = await this.banco.execute<{
      id: string; transaction_id: string; direction: LedgerEntryState["direction"]; sequencia: string;
      currency: string; amount: string; balance_before: string; balance_after: string; created_at: Date;
    }[]>(`
      select * from wallet_ledger_entries where wallet_id = ? and sequencia > ? order by sequencia limit ?
    `, [walletId, sequencia, limite + 1]);
    const pagina = linhas.slice(0, limite);
    return {
      entries: pagina.map((linha) => ({
        id: linha.id, walletId, transactionId: linha.transaction_id, direction: linha.direction, createdAt: linha.created_at,
        money: lerMoney(linha.amount, linha.currency), balanceBefore: lerMoney(linha.balance_before, linha.currency),
        balanceAfter: lerMoney(linha.balance_after, linha.currency),
      })),
      nextCursor: linhas.length > limite ? Buffer.from(pagina[limite - 1].sequencia).toString("base64url") : null,
    };
  }

  // A consulta única compara saldo e soma no mesmo snapshot, mesmo sob escrita concorrente.
  reconciliar(walletId: string) {
    return this.banco.execute<{ currency: string; balance: string; calculado: string; quantidade: string }>(`
      select w.currency, w.balance, coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as calculado,
        count(l.id)::text as quantidade
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id
    `, [walletId], "get");
  }
}
