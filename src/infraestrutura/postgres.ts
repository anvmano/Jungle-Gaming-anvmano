import { Migrator } from "@mikro-orm/migrations";
import { MikroORM } from "@mikro-orm/postgresql";
import { Migration20261105000100 } from "../../migracoes/001-criar-esquema-financeiro";
import { Migration20261105000200 } from "../../migracoes/002-registrar-eventos-recebidos";
import { Migration20261106000100 } from "../../migracoes/003-agendar-referencias-e-proteger-reversoes";

// Valida o endereço do banco e inicializa o MikroORM com o executor de migrações.
export function conectarPostgres(enderecoBanco = process.env.URL_BANCO) {
  const endereco = URL.parse(enderecoBanco ?? "");
  if (!endereco || !["postgres:", "postgresql:"].includes(endereco.protocol)) {
    throw new Error("Informe uma URL de conexão do PostgreSQL");
  }

  return MikroORM.init({
    clientUrl: enderecoBanco,
    // Limita a espera por conexões quando a dependência estiver indisponível.
    pool: { min: 0, max: 10, acquireTimeoutMillis: 3000 },
    driverOptions: {
      connection: { connectionTimeoutMillis: 3000 },
      // O driver pode incluir consultas nos avisos. Mantém apenas o diagnóstico seguro em JSON.
      log: {
        warn: () => console.warn(JSON.stringify({ evento: "aviso_conexao_postgres" })),
        error: () => console.error(JSON.stringify({ evento: "erro_conexao_postgres" })),
      },
    },
    extensions: [Migrator],
    entities: [],
    // O domínio fica separado do ORM. O acesso SQL usa migrações e mapeadores explícitos.
    discovery: { warnWhenNoEntities: false },
    // Registre as migrações em ordem. O MikroORM usa o nome da classe já gravado no banco, mesmo se o arquivo mudar.
    migrations: {
      path: "migracoes",
      migrationsList: [Migration20261105000100, Migration20261105000200, Migration20261106000100],
      snapshot: false,
    },
  });
}
