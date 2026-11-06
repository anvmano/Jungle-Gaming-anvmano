import { Migration } from "@mikro-orm/migrations";

// Guarda o efeito auditável do consumidor de demonstração uma única vez por evento.
export class Migration20261105000200 extends Migration {
  // A identidade persistente protege inclusive reenvios fora da janela de deduplicação FIFO.
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE eventos_recebidos (
        event_id uuid PRIMARY KEY,
        payload_hash text NOT NULL,
        payload jsonb NOT NULL,
        recebido_em timestamptz NOT NULL DEFAULT now()
      );
      GRANT SELECT, INSERT ON eventos_recebidos TO jungle_app;
    `);
  }

  // Remove somente a estrutura criada para o consumidor de demonstração.
  override async down(): Promise<void> {
    this.addSql("DROP TABLE eventos_recebidos");
  }
}
