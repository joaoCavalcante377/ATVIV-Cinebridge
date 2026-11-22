# cinebridge-api: recomendação e orquestração de equipes (porta 3000)
# A atividade sugere node:18-alpine; o projeto usa Node 24 (veja docs/atv4.md, "Imagem base").
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

# curl é usado pelo healthcheck do Compose (as imagens Alpine não o trazem).
RUN apk add --no-cache curl

WORKDIR /usr/src/app
ENV NODE_ENV=production

# Dependências primeiro: a camada fica em cache enquanto package*.json não mudar.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
# Pasta do armazenamento local de arquivos (Adapter da ATVIII), gravável pelo usuário sem privilégios.
RUN mkdir -p .local/arquivos && chown -R node:node .local

ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
# Node 24 executa TypeScript diretamente (remoção de tipos), sem etapa de compilação.
CMD ["node", "src/server.ts"]
