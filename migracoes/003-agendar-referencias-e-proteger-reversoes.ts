import { Migration } from "@mikro-orm/migrations";

// Amplia a base sem reescrever migrações anteriores ou alterar lançamentos financeiros existentes.
export class Migration20261106000100 extends Migration {
  // Protege referências aplicadas e reserva o agendamento durável usado pelo futuro worker.
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN tentativas_referencia integer NOT NULL DEFAULT 0 CHECK (tentativas_referencia >= 0),
        ADD COLUMN proxima_tentativa_referencia timestamptz,
        ADD COLUMN expira_referencia_em timestamptz,
        ADD CONSTRAINT referencia_por_tipo CHECK (
          reference_external_transaction_id IS NULL OR
          (kind IN ('WIN','REFUND','ROLLBACK') AND length(reference_external_transaction_id) BETWEEN 1 AND 128)),
        ADD CONSTRAINT referencia_resolvida CHECK (
          status <> 'PROCESSED' OR
          (reference_external_transaction_id IS NULL AND reference_transaction_id IS NULL) OR
          (reference_external_transaction_id IS NOT NULL AND reference_transaction_id IS NOT NULL)),
        ADD CONSTRAINT referencia_sem_autovinculo CHECK (reference_transaction_id IS DISTINCT FROM id),
        ADD CONSTRAINT referencia_agendada CHECK (status <> 'PENDING_REFERENCE' OR
          (proxima_tentativa_referencia IS NOT NULL AND expira_referencia_em IS NOT NULL));
      CREATE UNIQUE INDEX indice_reversao_efetiva ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX indice_referencia_pendente ON wager_transactions (proxima_tentativa_referencia, id)
        WHERE status = 'PENDING_REFERENCE';
      GRANT UPDATE (tentativas_referencia, proxima_tentativa_referencia) ON wager_transactions TO jungle_app;
    `);

    // A identidade e o vencimento permanecem imutáveis; somente o agendamento poderá avançar.
    this.atualizarProtecao(true);

    // A referência terminal é imutável; sua leitura não precisa bloquear outra wallet.
    this.addSql(`
      CREATE FUNCTION validar_referencia_processada() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE referencia wager_transactions%ROWTYPE;
      BEGIN
        IF NEW.status = 'PROCESSED' AND NEW.reference_external_transaction_id IS NOT NULL THEN
          SELECT * INTO referencia FROM wager_transactions WHERE id = NEW.reference_transaction_id;
          IF NOT FOUND OR referencia.status <> 'PROCESSED'
            OR referencia.provider_id <> NEW.provider_id
            OR referencia.external_transaction_id <> NEW.reference_external_transaction_id
            OR referencia.player_id <> NEW.player_id OR referencia.wallet_id <> NEW.wallet_id
            OR referencia.currency <> NEW.currency OR referencia.round_id <> NEW.round_id
            OR (NEW.kind IN ('WIN','REFUND') AND referencia.kind <> 'BET')
            OR (NEW.kind = 'ROLLBACK' AND referencia.kind NOT IN ('BET','WIN','REFUND'))
            OR (NEW.kind IN ('REFUND','ROLLBACK') AND referencia.amount <> NEW.amount) THEN
            RAISE EXCEPTION 'Referência incompatível com a transação processada' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER validar_referencia_processada BEFORE INSERT OR UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION validar_referencia_processada();
    `);
  }

  // Retira somente as proteções desta etapa; não remove transações, eventos ou lançamentos.
  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER validar_referencia_processada ON wager_transactions;
      DROP FUNCTION validar_referencia_processada();
      DROP INDEX indice_reversao_efetiva, indice_referencia_pendente;
      REVOKE UPDATE (tentativas_referencia, proxima_tentativa_referencia) ON wager_transactions FROM jungle_app;
      ALTER TABLE wager_transactions
        DROP CONSTRAINT referencia_por_tipo, DROP CONSTRAINT referencia_resolvida,
        DROP CONSTRAINT referencia_sem_autovinculo, DROP CONSTRAINT referencia_agendada,
        DROP COLUMN tentativas_referencia, DROP COLUMN proxima_tentativa_referencia, DROP COLUMN expira_referencia_em;
    `);
    this.atualizarProtecao(false);
  }

  // Mantém a proteção terminal original e libera apenas as colunas operacionais do agendamento.
  private atualizarProtecao(agendamento: boolean): void {
    const campos = "'status','balance','failure_code','processed_at','reference_transaction_id'" +
      (agendamento ? ",'tentativas_referencia','proxima_tentativa_referencia'" : "");
    this.addSql(`
      CREATE OR REPLACE FUNCTION proteger_transacao() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') OR TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'A transação não pode ser alterada ou removida' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY[${campos}]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[${campos}]) THEN
          RAISE EXCEPTION 'A identidade da transação não pode mudar' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
  }
}
