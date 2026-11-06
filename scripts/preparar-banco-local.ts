import { conectarPostgres } from "../src/infraestrutura/postgres";

// Provisiona a conta restrita do Compose em volumes novos ou existentes.
const enderecoMigracoes = process.env.URL_BANCO_MIGRACOES;
const senhaAplicacao = process.env.SENHA_BANCO_APLICACAO;
if (!enderecoMigracoes || !senhaAplicacao) {
  throw new Error("Informe URL_BANCO_MIGRACOES e SENHA_BANCO_APLICACAO");
}

// Delega ao PostgreSQL o escape da senha e cria a conta somente se necessário.
const conexao = await conectarPostgres(enderecoMigracoes);
try {
  const existente = await conexao.em.execute<{ existe: boolean }>(
    "select exists(select 1 from pg_roles where rolname = 'jungle_app') as existe", [], "get",
  );
  if (!existente.existe) {
    const comando = await conexao.em.execute<{ sql: string }>(
      "select format('CREATE ROLE jungle_app LOGIN PASSWORD %L', ?::text) as sql", [senhaAplicacao], "get",
    );
    await conexao.em.execute(comando.sql);
  }
} finally {
  await conexao.close();
}
