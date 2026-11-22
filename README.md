# ATVIV — Cinebridge

Plataforma para recomendar profissionais e formar equipes de projetos audiovisuais, agora **containerizada** e dividida em microsserviços que se comunicam por **RabbitMQ**. Continuação da [ATVIII-Cinebridge](https://github.com/joaoCavalcante377/ATVIII-Cinebridge), que continua a [ATVII](https://github.com/joaoCavalcante377/ATVII-Cinebridge) e a [ATVI](https://github.com/joaoCavalcante377/ATVI-Cinebridge).

| Contêiner | Porta | Função | Banco |
|---|---|---|---|
| `cinebridge-api` | 3000 | Recomendação e orquestração; ponto de entrada REST | `recomendacoes-db` (5434) |
| `cinebridge-profissionais` | 3001 | Cadastro, competências, avaliações e disponibilidade | `profissionais-db` (5432) |
| `cinebridge-projetos` | 3002 | Ciclo de vida, métricas e resultados dos projetos | `projetos-db` (5433) |
| `cinebridge-notificacoes` | 3003 | E-mails (simulados) e mensagens internas | `notificacoes-db` (5435) |
| `cinebridge-mq` | 5672, 15672 | RabbitMQ com interface de gerenciamento | — |

![Diagrama de implantação](docs/diagrama-implantacao.png)

Os serviços não chamam uns aos outros por HTTP. O recomendador consulta profissionais e projetos por filas RPC (`consulta-profissionais`, `consulta-projetos`) e publica seus eventos em `eventos-recomendacoes`; o serviço de projetos publica o ciclo de vida em `eventos-projetos`, consumida pelas notificações. Arquitetura, contratos das filas, garantias de entrega e decisões: **[docs/atv4.md](docs/atv4.md)**.

## Requisitos

| Sistema | Instalação |
|---|---|
| **Windows 10 ou superior** | [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) com backend WSL 2. Inclui Docker Engine, Docker Compose e interface gráfica |
| **Ubuntu 24.04.3 ou superior** (e derivadas) | [Docker Engine](https://docs.docker.com/engine/install/ubuntu/) com o plugin Compose: `sudo apt install docker-ce docker-ce-cli containerd.io docker-compose-plugin` (após adicionar o repositório oficial do Docker) |

Verifique a instalação:

```sh
docker --version
docker compose version     # ou: docker-compose --version
```

Para rodar a demonstração ponta a ponta no host também é preciso **Node.js 18 ou superior** (o script não tem dependências). Para desenvolver e testar os serviços fora do Docker, **Node.js 24**.

## Como executar

```sh
git clone https://github.com/joaoCavalcante377/ATVIV-Cinebridge.git
cd ATVIV-Cinebridge
docker compose up -d --build
```

Na primeira vez as imagens são construídas e baixadas (alguns minutos). Os serviços só iniciam depois que seus bancos e o RabbitMQ ficam saudáveis. Acompanhe:

```sh
docker compose ps          # todos devem ficar "healthy"
docker compose logs -f     # logs de todos os contêineres (Ctrl+C para sair)
docker compose logs -f cinebridge-notificacoes
```

O comando `docker-compose up -d` (Compose v1 ou o atalho do Docker Desktop) também funciona.

Com tudo saudável, rode a demonstração ponta a ponta. Ela cria um projeto, passa por convites, recusa, aceites e pagamento, e confere o registro no serviço de projetos, as notificações e o tráfego das filas:

```sh
node scripts/demo-atv4.mjs
```

A interface do RabbitMQ fica em **http://localhost:15672** (usuário `guest`, senha `guest`): filas, taxas de entrega, consumidores e as filas de falhas (`*.falhas`).

Para encerrar:

```sh
docker compose down        # para e remove os contêineres; os dados ficam nos volumes
docker compose down -v     # também apaga os volumes (bancos e filas)
```

## Rotas

Todas as rotas usam JSON. Valores monetários em **centavos**, datas `AAAA-MM-DD`.

### cinebridge-api — http://localhost:3000

As rotas da ATVIII continuam disponíveis ([referência completa](services/api/docs/api.md)). As principais:

| Método | Rota | Operação |
|---|---|---|
| GET | `/health` | Banco e RabbitMQ operacionais (200) ou 503 |
| POST | `/projetos` | Criar projeto e recomendar equipe (profissionais via `consulta-profissionais`) |
| POST | `/projetos/modelos/:nome` | Criar a partir de um modelo (`padrao`, `documentario`, `animacao`, `publicitario`) |
| GET | `/projetos/:id` | Projeto, equipe, recomendação e convites |
| GET | `/projetos/:id/acompanhamento` | Registro no serviço de projetos (via `consulta-projetos`) |
| POST | `/projetos/:id/aceitar` | Aceitar sugestões e emitir convites |
| POST | `/projetos/:id/convites/:conviteId/resposta` | Profissional aceita ou recusa |
| POST | `/projetos/:id/membros/:papel/substituir` | Substituir integrante |
| POST | `/projetos/:id/reavaliar` | Alterar critérios e recalcular |
| POST | `/projetos/:id/pagamentos` | Pagar a equipe confirmada (finaliza o projeto) |
| POST | `/profissionais/:id/avaliacoes` | Avaliar profissional (encaminhado pela fila) |
| GET | `/projetos/:id/relatorio`, `/servicos`, `/auditoria` | Relatório, pacotes de serviços e auditoria |

### cinebridge-profissionais — http://localhost:3001

| Método | Rota | Operação |
|---|---|---|
| GET | `/health` | Banco e RabbitMQ |
| POST | `/profissionais` | Cadastrar profissional |
| GET | `/profissionais?papel=&localizacao=&inicio=&fim=&limite=` | Listar com filtros |
| GET | `/profissionais/:id` | Detalhar |
| POST | `/profissionais/:id/avaliacoes` | Registrar avaliação |

Na inicialização são cadastrados os **27 profissionais fictícios** do seed das atividades anteriores (somente os que ainda não existem; `SEED=false` desativa).

### cinebridge-projetos — http://localhost:3002

| Método | Rota | Operação |
|---|---|---|
| GET | `/health` | Banco e RabbitMQ |
| GET | `/projetos?status=` | Listar (`CRIADO`, `EM_ANDAMENTO`, `EQUIPE_CONFIRMADA`, `FINALIZADO`) |
| GET | `/projetos/:id` | Status, configuração, métricas e resultados |
| POST | `/projetos` | Cadastro manual `{ titulo, tipoProjeto?, dados? }` |
| PATCH | `/projetos/:id` | Alterar título ou configuração |
| POST | `/projetos/:id/finalizar` | Finalizar `{ resumo? }` |

Os projetos criados no recomendador aparecem aqui automaticamente, pelos eventos. Toda mudança publica `projeto.criado`, `projeto.atualizado` ou `projeto.finalizado` em `eventos-projetos`.

### cinebridge-notificacoes — http://localhost:3003

| Método | Rota | Operação |
|---|---|---|
| GET | `/health` | Banco, RabbitMQ e observadores assinantes |
| GET | `/notificacoes?projetoId=&destinatario=&canal=&limite=` | Listar (`canal`: `email` ou `interno`) |
| GET | `/notificacoes/:id` | Detalhar |

## Exemplo rápido

No Linux ou no Git Bash:

```sh
curl -s -X POST localhost:3000/projetos -H 'content-type: application/json' -d @services/api/examples/projeto.json
# use o "id" de "projeto" na resposta:
curl -s localhost:3002/projetos/ID_DO_PROJETO
curl -s "localhost:3003/notificacoes?projetoId=ID_DO_PROJETO"
```

No PowerShell:

```powershell
$estado = Invoke-RestMethod -Method Post -Uri http://localhost:3000/projetos -ContentType 'application/json' -InFile services/api/examples/projeto.json
$id = $estado.projeto.id
Invoke-RestMethod http://localhost:3002/projetos/$id
Invoke-RestMethod "http://localhost:3003/notificacoes?projetoId=$id"
```

O registro em projetos e as notificações chegam alguns milissegundos depois da resposta do recomendador (comunicação assíncrona).

## Configuração

Cada serviço tem seu arquivo de variáveis para o Compose (`services/<serviço>/docker.env`) e um `.env.example` para execução fora do Docker. As credenciais são de desenvolvimento local.

| Variável | Serviços | Finalidade |
|---|---|---|
| `DATABASE_URL` | todos | PostgreSQL do próprio serviço (no Compose, pelo nome do contêiner, por exemplo `profissionais-db`) |
| `AMQP_URL` | todos | RabbitMQ, `amqp://guest:guest@cinebridge-mq:5672` |
| `PORT`, `HOST` | todos | Porta e endereço de escuta (`0.0.0.0` no contêiner) |
| `DB_MIGRAR` | api | Aplica as migrações TypeORM ao iniciar |
| `SEED` | profissionais | Cadastra os profissionais fictícios (`true` por padrão) |
| `CANAIS` | notificações | Observadores assinantes: `email,interno` |
| `ARMAZENAMENTO`, `PAGAMENTO`, `RECOMENDACAO_DECORADORES` | api | Provedores e decoradores da ATVIII |

As portas publicadas no host podem ser trocadas sem editar o Compose, por variáveis de ambiente ou por um arquivo `.env` na raiz: `API_PORTA`, `PROFISSIONAIS_PORTA`, `PROJETOS_PORTA`, `NOTIFICACOES_PORTA`, `PROFISSIONAIS_DB_PORTA`, `PROJETOS_DB_PORTA`, `RECOMENDACOES_DB_PORTA`, `NOTIFICACOES_DB_PORTA`, `MQ_PORTA`, `MQ_GERENCIAMENTO_PORTA`. Exemplo de `.env`:

```dotenv
PROFISSIONAIS_DB_PORTA=55432
```

## Testes

Com Node.js 24:

```sh
npm run instalar        # npm ci em cada serviço
npm test                # cópias da mensageria idênticas + testes dos 4 serviços
npm run typecheck
```

Os testes de integração do recomendador usam PostgreSQL e RabbitMQ reais. Com a stack no ar, por exemplo:

```sh
cd services/api
docker compose -f ../../docker-compose.yml exec recomendacoes-db createdb -U cinebridge cinebridge_test
TEST_DATABASE_URL=postgres://cinebridge:cinebridge@127.0.0.1:5434/cinebridge_test \
TEST_AMQP_URL=amqp://guest:guest@127.0.0.1:5672 npm run test:coverage
```

O teste da mensageria cria e remove um vhost temporário, sem interferir nas filas da stack. Resultados e cenários de falha validados: [docs/atv4.md](docs/atv4.md#validação).

## Estrutura

```text
docker-compose.yml        Orquestração: 4 serviços, 4 bancos, RabbitMQ, rede cinebridge-net
services/
  api/                    cinebridge-api: recomendador das ATVI–ATVIII + adaptador e publicador RabbitMQ
  profissionais/          cinebridge-profissionais
  projetos/               cinebridge-projetos
  notificacoes/           cinebridge-notificacoes
    Dockerfile, .dockerignore, docker.env, .env.example, src/, test/
scripts/
  demo-atv4.mjs           Demonstração e verificação ponta a ponta
  verificar-mensageria.mjs
docs/
  atv4.md                 Arquitetura, filas, garantias e decisões da ATVIV
  diagrama-implantacao.*  Diagrama de implantação (PNG do enunciado e PlantUML)
```

A documentação das atividades anteriores está em [services/api/README.md](services/api/README.md) e [services/api/docs](services/api/docs).

## Problemas comuns

- **`Bind for 0.0.0.0:5432 failed: port is already allocated`:** outro PostgreSQL (local ou em contêiner) já usa a porta. Defina outra porta no host, por exemplo `PROFISSIONAIS_DB_PORTA=55432` em um `.env` na raiz, e rode `docker compose up -d` de novo. Vale para as demais portas.
- **`docker: command not found` no WSL:** ative a integração com a distribuição em Docker Desktop → Settings → Resources → WSL integration.
- **`failed to connect to the docker API`:** o Docker Desktop (ou o serviço `docker` no Linux) não está em execução. No Ubuntu, sem `sudo`, adicione seu usuário ao grupo `docker`.
- **Serviço `unhealthy`:** veja `docker compose logs <serviço>`. O `/health` informa se o problema é o banco ou o RabbitMQ.
- **`/projetos/:id/acompanhamento` retorna 404 logo após criar:** o registro chega de forma assíncrona; tente de novo em instantes.
- **Recomendação `degradada`:** o serviço de profissionais não respondeu em 2,5 s (por exemplo, ainda iniciando). Confira `docker compose ps`.
