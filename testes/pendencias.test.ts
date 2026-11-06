import { expect, test } from "bun:test";
import { calcularAtrasoReferencia, lerConfiguracaoPendencias } from "../src/aplicacao/configuracao-pendencias";

// A espera inicial e as tentativas subsequentes devem respeitar o crescimento e o teto acordados.
test("Backoff de referências cresce de 1 segundo até o teto de 60 segundos", () => {
  const configuracao = lerConfiguracaoPendencias({});
  expect(configuracao.ttlMs).toBe(900000);
  expect([0, 1, 2, 3, 4, 5, 6, 7, 1000].map((tentativas) => calcularAtrasoReferencia(tentativas, configuracao)))
    .toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

// Os parâmetros aceitam testes rápidos, mas nunca valores que causem loop sem pausa ou estouro.
test("Configuração de pendências valida números e a relação entre atraso inicial e teto", () => {
  for (const campo of ["REFERENCIAS_ATRASO_INICIAL_MS", "REFERENCIAS_ATRASO_MAXIMO_MS", "REFERENCIAS_TTL_MS", "REFERENCIAS_INTERVALO_MS"]) {
    for (const invalido of ["", "0", "-1", "1.5", "1e3", " 1", "Infinity", "99999999999999999999"]) {
      expect(() => lerConfiguracaoPendencias({ [campo]: invalido })).toThrow();
    }
  }
  expect(() => lerConfiguracaoPendencias({ REFERENCIAS_ATRASO_INICIAL_MS: "2000", REFERENCIAS_ATRASO_MAXIMO_MS: "1000" })).toThrow();
  const configuracao = lerConfiguracaoPendencias({ REFERENCIAS_ATRASO_INICIAL_MS: "20", REFERENCIAS_ATRASO_MAXIMO_MS: "50", REFERENCIAS_TTL_MS: "10" });
  expect(calcularAtrasoReferencia(2, configuracao)).toBe(50);
  expect(configuracao.ttlMs).toBe(10);
});
