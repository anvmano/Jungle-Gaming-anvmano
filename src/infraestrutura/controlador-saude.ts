import { Controller, Get, HttpException, Inject } from "@nestjs/common";
import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { criarClienteSqs } from "./filas";

// Mantém os endpoints de saúde abertos e independentes da identidade do provedor.
@Controller("health")
export class ControladorSaude {
  private readonly cliente = criarClienteSqs();

  // Recebe o pool usado pela aplicação para verificar a conexão real.
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  // Confirma apenas que o processo consegue responder HTTP.
  @Get("live")
  verificarVida() { return { status: "ok" }; }

  // Verifica PostgreSQL e SQS com prazos limitados e sem expor detalhes internos.
  @Get("ready")
  async verificarProntidao() {
    const resultados = await Promise.allSettled([
      this.orm.em.fork().transactional(async (banco) => {
        await banco.execute("set local statement_timeout = '2s'");
        await banco.execute("select 1");
      }),
      this.cliente.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: AbortSignal.timeout(3000) }),
    ]);
    const dependencias = { postgres: resultados[0].status === "fulfilled", sqs: resultados[1].status === "fulfilled" };
    if (!dependencias.postgres || !dependencias.sqs) throw new HttpException({ status: "indisponivel", ...dependencias }, 503);
    return { status: "ok", ...dependencias };
  }

  // Fecha as conexões HTTP do cliente usado pelas sondagens.
  onApplicationShutdown(): void { this.cliente.destroy(); }
}
