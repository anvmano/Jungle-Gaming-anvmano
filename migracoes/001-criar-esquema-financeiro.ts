import { Migration } from "@mikro-orm/migrations";

// Cria a base financeira e entrega ao papel da aplicação somente os acessos necessários.
export class Migration20261105000100 extends Migration {
  // Define tabelas, vínculos, proteções e índices numa migração transacional.
  override async up(): Promise<void> {
    // Uma wallet por jogador e moeda, com versão inicial positiva.
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$' AND length(currency) = 3),
        balance bigint NOT NULL CHECK (balance >= 0),
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency),
        UNIQUE (id, currency)
      )
    `);

    // As duas identidades de idempotência são independentes. O saldo do resultado é histórico.
    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        payload_hash text NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash ~ '^[0-9a-f]+$'),
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount bigint NOT NULL CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$' AND length(currency) = 3),
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        balance bigint CHECK (balance >= 0),
        failure_code text,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        UNIQUE (provider_id, external_transaction_id),
        UNIQUE (id, wallet_id, currency),
        CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL),
        CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CHECK (status NOT IN ('PROCESSED','REJECTED') OR balance IS NOT NULL)
      )
    `);

    // Os vínculos compostos exigem que transação, wallet e lançamento concordem sobre a moeda.
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        sequencia bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        currency text NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount bigint NOT NULL CHECK (amount > 0),
        balance_before bigint NOT NULL CHECK (balance_before >= 0),
        balance_after bigint NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL,
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
        UNIQUE (transaction_id, wallet_id),
        CHECK (balance_after::numeric - balance_before::numeric =
          CASE direction WHEN 'CREDIT' THEN amount::numeric ELSE -amount::numeric END)
      )
    `);
    this.addSql("CREATE INDEX indice_ledger_wallet_sequencia ON wallet_ledger_entries (wallet_id, sequencia)");

    // O consumidor e o identificador da mensagem formam a chave da inbox.
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash text NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash ~ '^[0-9a-f]+$'),
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    // O evento mantém a mesma identidade enquanto o publicador atualiza o agendamento.
    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz
      )
    `);
    this.addSql("CREATE INDEX indice_outbox_pendente ON outbox_messages (next_attempt_at, occurred_at, id) WHERE published_at IS NULL");

    // Protege o ledger mesmo quando a conexão tem privilégios de alteração de linhas.
    this.addSql(`
      CREATE FUNCTION impedir_alteracao_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Lançamentos do ledger são imutáveis' USING ERRCODE = '23514';
      END;
      $$;
      CREATE TRIGGER proteger_ledger BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_ledger();
    `);

    // O resultado terminal não pode mudar. A identidade permanece fixa em qualquer estado.
    this.addSql(`
      CREATE FUNCTION proteger_transacao() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') OR TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'A transação não pode ser alterada ou removida' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['status','balance','failure_code','processed_at','reference_transaction_id'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status','balance','failure_code','processed_at','reference_transaction_id']) THEN
          RAISE EXCEPTION 'A identidade da transação não pode mudar' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER proteger_transacao BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION proteger_transacao();
    `);

    // Nenhuma tabela concede DELETE, TRUNCATE ou propriedade ao papel da aplicação.
    this.addSql(`
      GRANT USAGE ON SCHEMA public TO jungle_app;
      GRANT SELECT, INSERT ON wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages TO jungle_app;
      GRANT UPDATE (balance, version, updated_at) ON wallets TO jungle_app;
      GRANT UPDATE (status, balance, failure_code, processed_at, reference_transaction_id) ON wager_transactions TO jungle_app;
      GRANT UPDATE (processed_at) ON inbox_messages TO jungle_app;
      GRANT UPDATE (attempts, next_attempt_at, published_at) ON outbox_messages TO jungle_app;
    `);
  }

  // Remove objetos da migração em ordem inversa, preservando a conta de conexão provisionada fora dela.
  override async down(): Promise<void> {
    this.addSql("DROP TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets");
    this.addSql("DROP FUNCTION proteger_transacao(), impedir_alteracao_ledger()");
    this.addSql("REVOKE USAGE ON SCHEMA public FROM jungle_app");
  }
}
