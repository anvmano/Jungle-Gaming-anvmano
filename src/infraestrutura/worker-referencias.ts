import type { ServicoFinanceiro } from "../aplicacao/servico-financeiro";

// Cada réplica tenta retomar pendências. Os locks e o agendamento ficam no PostgreSQL.
export class WorkerReferencias {
  private encerrando = false;
  private tarefa?: Promise<void>;

  // A pausa do ciclo vale quando não há trabalho ou após falha técnica. O intervalo de cada pendência fica no banco.
  constructor(private readonly financeiro: ServicoFinanceiro, private readonly intervaloMs: number) {}

  // Inicia sem bloquear a subida do HTTP.
  onApplicationBootstrap(): void { this.tarefa = this.executar(); }

  // Interrompe a seleção e termina a transação corrente antes de o serviço fechar o pool.
  async beforeApplicationShutdown(): Promise<void> {
    this.encerrando = true;
    await this.tarefa;
  }

  // Uma falha técnica desfaz a tentativa e mantém a pendência disponível para qualquer réplica.
  private async executar(): Promise<void> {
    while (!this.encerrando) {
      try {
        if (await this.financeiro.reprocessarPendencia()) continue;
      } catch {
        console.error(JSON.stringify({ evento: "falha_temporaria_referencias" }));
      }
      await Bun.sleep(this.intervaloMs);
    }
  }
}
