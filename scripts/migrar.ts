import { conectarPostgres } from "../src/infraestrutura/postgres";

// Aceita somente as ações expostas pelos comandos do projeto.
const acao = Bun.argv[2];
if (acao !== "aplicar" && acao !== "reverter") {
  throw new Error("Use migrar:aplicar ou migrar:reverter");
}

// Exige a configuração de conexão destinada às migrações.
const enderecoBancoMigracoes = process.env.URL_BANCO_MIGRACOES;
if (!enderecoBancoMigracoes) {
  throw new Error("URL_BANCO_MIGRACOES é obrigatória");
}

// Fecha a conexão mesmo se uma migração falhar.
const conexao = await conectarPostgres(enderecoBancoMigracoes);
try {
  const executorMigracoes = conexao.getMigrator();
  const migracoes = acao === "aplicar" ? await executorMigracoes.up() : await executorMigracoes.down();
  console.log(`Migrações executadas: ${migracoes.length}`);
} finally {
  await conexao.close();
}
