# Cockpit em outra máquina (desenvolvimento / homologação)

Sobe tudo em Docker, com Postgres próprio: **postgres**, **cockpit** (app), **metabase** e o **etl** (sob demanda).
Não toca na produção e não precisa da rede do bot.

## Pré-requisitos
- Docker Desktop (Mac/Windows) ou Docker Engine + Compose v2 (Linux).
- Repositório clonado: `git clone https://github.com/forjaassistente/pepper-cockpit`

## Primeira instalação
```bash
cd pepper-cockpit
cp deploy/local/.env.example deploy/.env        # preencher as senhas (openssl rand -base64 24)
docker compose -f deploy/docker-compose.local.yml up -d --build
docker compose -f deploy/docker-compose.local.yml logs -f postgres   # esperar "banco pronto"
```
- Cockpit: http://localhost:3001. O primeiro acesso pede para criar o admin (nome, CPF e senha).
- Metabase: http://localhost:3000. Ao configurar, adicione o banco Postgres com host `postgres`,
  banco `pepper_bi`, usuário `bi_reader` e a senha `BI_READER_PASSWORD` do `.env`.
- Postgres (para DBeaver/psql): `localhost:5433`, usuário `postgres`.

No primeiro `up`, o `init-db.sh` cria os papéis (`bi_etl`, `bi_reader`, `fin_app_owner`, `fin_app_rw`,
`metabase_app`), os schemas `raw`/`bi` (pelos `etl/*_schema.sql`) e aplica todas as migrações de `sql/`.
Ele só roda com o volume vazio.

## Banco vazio
O banco nasce sem dados. O Painel (`/api/resumo`) dá erro até existir ao menos um dia em `bi.faturamento_dia`.
Para ter dados:
- **ETL**: copiar `etl/google-sa.json` para esta máquina e preencher `NIBO_API_TOKEN` no `.env`, depois
  ```bash
  docker compose -f deploy/docker-compose.local.yml --profile etl run --rm etl nibo.py
  docker compose -f deploy/docker-compose.local.yml --profile etl run --rm etl sheets.py
  ```
- **Cópia da produção** (dados reais do restaurante: guardar com cuidado e apagar quando não precisar):
  ```bash
  # no servidor
  docker exec pepper-sally-postgres pg_dump -U <superuser> -Fc pepper_bi > pepper_bi.dump
  # nesta máquina, com o compose já no ar
  docker compose -f deploy/docker-compose.local.yml exec -T postgres \
    pg_restore -U postgres -d pepper_bi --clean --if-exists --no-acl < pepper_bi.dump
  ```
  Depois do restore, refaça as permissões do `init-db.sh` se alguma tela der "permission denied".

## Migração nova
```bash
docker compose -f deploy/docker-compose.local.yml exec -T postgres \
  psql -U postgres -d pepper_bi -v ON_ERROR_STOP=1 < sql/NNN_nome.sql
```
(As que não têm `SET ROLE fin_app_owner` no arquivo: rodar com `-c "set role fin_app_owner" -f -`.)

## Atualizar o app depois de mexer no código
```bash
docker compose -f deploy/docker-compose.local.yml up -d --build cockpit
```

## Zerar tudo (apaga banco e anexos desta máquina)
```bash
docker compose -f deploy/docker-compose.local.yml down -v
```
