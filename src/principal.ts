import "reflect-metadata";
import { ConsoleLogger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ServicoFinanceiro } from "./aplicacao/servico-financeiro";
import { ControladorFinanceiro } from "./infraestrutura/controlador-financeiro";
import { conectarPostgres } from "./infraestrutura/postgres";
import { MikroORM } from "@mikro-orm/postgresql";
import { Mensageria } from "./infraestrutura/mensageria";
import { criarClienteSqs, localizarFilas } from "./infraestrutura/filas";
import { ControladorSaude } from "./infraestrutura/controlador-saude";
import { WorkerReferencias } from "./infraestrutura/worker-referencias";
import { lerConfiguracaoPendencias } from "./aplicacao/configuracao-pendencias";

// Valida a configuração uma vez e compartilha os mesmos tempos entre entrada e worker.
const configuracaoPendencias = lerConfiguracaoPendencias();
const referenciasAtivas = process.env.REFERENCIAS_ATIVAS ?? "true";
if (!["true", "false"].includes(referenciasAtivas)) throw new Error("REFERENCIAS_ATIVAS deve ser true ou false");

// Registra os controladores expostos pela aplicação.
@Module({
  controllers: [ControladorSaude, ControladorFinanceiro],
  providers: [
    { provide: MikroORM, useFactory: () => conectarPostgres() },
    { provide: ServicoFinanceiro, inject: [MikroORM], useFactory: (orm: MikroORM) => new ServicoFinanceiro(orm, configuracaoPendencias) },
    // O worker independe do broker e também funciona em uma réplica somente HTTP.
    ...(referenciasAtivas === "true" ? [{
      provide: WorkerReferencias, inject: [ServicoFinanceiro],
      useFactory: (financeiro: ServicoFinanceiro) => new WorkerReferencias(financeiro, configuracaoPendencias.intervaloConsultaMs),
    }] : []),
    // Os testes HTTP isolados iniciam apenas o servidor. O Compose habilita os três ciclos.
    ...(process.env.MENSAGERIA_ATIVA === "true" ? [{
      provide: Mensageria, inject: [MikroORM, ServicoFinanceiro],
      useFactory: async (orm: MikroORM, financeiro: ServicoFinanceiro) => {
        const cliente = criarClienteSqs();
        return new Mensageria(orm, financeiro, cliente, await localizarFilas(cliente));
      },
    }] : []),
  ],
})
class ModuloAplicacao {}

// Usa a porta padrão quando nenhuma porta é fornecida e rejeita valores inválidos.
const porta = Number(process.env.PORTA ?? "3000");
if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
  throw new Error("PORTA deve ser um inteiro entre 1 e 65535");
}

// Permite que o Nest encerre seus recursos ao receber um sinal do sistema.
const aplicacao = await NestFactory.create(ModuloAplicacao, { logger: new ConsoleLogger({ json: true }) });
aplicacao.enableShutdownHooks();
await aplicacao.listen(porta, "0.0.0.0");
