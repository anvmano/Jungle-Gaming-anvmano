import verificar from "node:assert/strict";
import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Money } from "../src/dominio/money";
import { gravarMoney, lerMoney } from "../src/infraestrutura/mapear-money";
import { conectarPostgres } from "../src/infraestrutura/postgres";

// Exige um endereço explícito para que o teste use o serviço SQS configurado.
const enderecoFila = URL.parse(process.env.URL_SQS ?? "");
if (!enderecoFila || !["http:", "https:"].includes(enderecoFila.protocol)) {
  throw new Error("URL_SQS deve ser uma URL HTTP ou HTTPS");
}

// Verifica o contrato HTTP do endpoint de vida com limite de espera.
const enderecoSaude = new URL("/health/live", process.env.URL_APLICACAO ?? "http://127.0.0.1:3000");
const respostaSaude = await fetch(enderecoSaude, { signal: AbortSignal.timeout(5000) });
verificar.equal(respostaSaude.status, 200);
verificar.deepEqual(await respostaSaude.json(), { status: "ok" });
// A prontidão confirma as dependências além da vida do processo.
const prontidao = await fetch(new URL("/health/ready", enderecoSaude), { signal: AbortSignal.timeout(8000) });
verificar.equal(prontidao.status, 200);
verificar.deepEqual(await prontidao.json(), { status: "ok", postgres: true, sqs: true });

// Confere a precisão do PostgreSQL e do mapeamento do ORM com um valor acima do limite seguro de number.
const conexao = await conectarPostgres();
try {
  const money = Money.from({ amount: "90071992547409.93", currency: "BRL" });

  // A tabela temporária some ao confirmar a transação, deixando o banco de desenvolvimento intacto.
  await conexao.em.transactional(async (gerenciadorEntidades) => {
    await gerenciadorEntidades.execute("create temporary table teste_valor (centavos bigint) on commit drop");
    await gerenciadorEntidades.execute("insert into teste_valor values (?)", [gravarMoney(money)]);
    const registro = await gerenciadorEntidades.execute<{ centavos: string }>("select centavos from teste_valor", [], "get");
    verificar.ok(lerMoney(registro.centavos, "BRL").equals(money));
  });
} finally {
  await conexao.close();
}

// Usa credenciais fictícias do MiniStack e confirma o acesso sem criar filas.
const clienteFila = new SQSClient({
  endpoint: enderecoFila.href,
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
try {
  const resultado = await clienteFila.send(new ListQueuesCommand({}), {
    abortSignal: AbortSignal.timeout(5000),
  });
  verificar.equal(resultado.$metadata.httpStatusCode, 200);
} finally {
  clienteFila.destroy();
}

console.log("Integração aprovada: HTTP do NestJS, bigint no PostgreSQL e listagem de filas SQS");
