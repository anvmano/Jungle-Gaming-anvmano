# Mantém a versão do Bun igual à versão usada no desenvolvimento.
FROM oven/bun:1.4.4
WORKDIR /app
# Reaproveita as dependências enquanto o manifesto e o lockfile não mudarem.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts ./scripts
COPY migracoes ./migracoes
COPY tsconfig.json ./
# Executa sem privilégios de administrador.
USER bun
EXPOSE 3000
CMD ["bun", "run", "iniciar"]
