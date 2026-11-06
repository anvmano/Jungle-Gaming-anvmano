import { criarClienteSqs, prepararFilas } from "../src/infraestrutura/filas";

// Prepara filas locais antes de iniciar os consumidores do Compose.
const cliente = criarClienteSqs();
try {
  await prepararFilas(cliente);
  console.log("Filas de comandos, eventos e DLQs preparadas");
} finally {
  cliente.destroy();
}
