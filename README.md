# Cockpit — gestão de restaurante

Sistema de gestão nascido no Pepper Sally (Joaçaba/SC): fechamento de caixa por canal, fluxo de caixa,
caixa de entrada de documentos, conciliação de notas fiscais, estoque com contagem cega, ficha técnica e CMV,
precificação, engenharia de cardápio, fichas de produção, equipe/RH, tarefas e checklists.

## Estrutura

| Pasta | O que é | No servidor |
|---|---|---|
| `*.py` (raiz) | API em FastAPI — um módulo por área (`caixa.py`, `compras.py`, `estoque.py`…) | `/opt/pepper-bi/app` |
| `static/` | Tela (SPA em JavaScript puro) e CSS | `/opt/pepper-bi/app/static` |
| `sql/` | Migrações numeradas do schema `fin_app` (aplicar em ordem) | `/opt/pepper-bi/app/sql` |
| `etl/` | Robôs que importam Nibo e Google Sheets para `raw`/`bi` (só leitura para o app) | `/opt/pepper-bi/etl` |
| `deploy/` | `docker-compose.yml` e `run-etl.sh` | `/opt/pepper-bi` |
| `.env.example` | Variáveis necessárias (sem valores) | `/opt/pepper-bi/.env` |

## Regras do banco
- Os lançamentos do Nibo e da planilha ficam em `raw`/`bi` e são **somente leitura** para o app.
- O app grava apenas no schema `fin_app`, com o usuário `fin_app_rw` (permissões por coluna).
- Migrações rodam como `fin_app_owner`; as que leem `raw.*` rodam depois de `RESET ROLE`.

## Publicar (hoje, manual)
```bash
scp <arquivos> root@<servidor>:/opt/pepper-bi/app/
ssh root@<servidor> 'cd /opt/pepper-bi && docker compose up -d --build cockpit'
# migração nova:
ssh root@<servidor> 'docker exec -i pepper-sally-postgres psql -U <superuser> -d pepper_bi -v ON_ERROR_STOP=1 -c "set role fin_app_owner" -f -' < sql/NNN_nome.sql
```
O app escuta só em `127.0.0.1:3001`; o acesso hoje é por túnel SSH.

## Segredos
Nunca versionar `.env`, `etl/google-sa.json`, anexos ou backups (ver `.gitignore`).

## Próximos passos (resumo)
Backup automático, testes das regras de dinheiro, homologação, multiempresa (empresa_id + RLS),
permissões por estabelecimento, configuração por estabelecimento e frontend em componentes (Vite).
