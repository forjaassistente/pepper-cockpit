-- Tarefas recorrentes (ao concluir, nasce a próxima) e checklists de rotina (abertura/fechamento) com avisos ao admin.
-- Idempotente.
SET ROLE fin_app_owner;

ALTER TABLE fin_app.tarefas ADD COLUMN IF NOT EXISTS recorrencia text CHECK (recorrencia IN ('diaria', 'semanal', 'mensal'));
ALTER TABLE fin_app.tarefas ADD COLUMN IF NOT EXISTS serie_id uuid;   -- todas as ocorrências da mesma tarefa recorrente

CREATE TABLE IF NOT EXISTS fin_app.checklists (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome         text NOT NULL,
    descricao    text,
    dias_semana  int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}' CHECK (dias_semana <@ ARRAY[0,1,2,3,4,5,6]),   -- 0 = domingo
    ativo        boolean NOT NULL DEFAULT true,
    criado_em    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fin_app.checklist_itens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checklist_id  uuid NOT NULL REFERENCES fin_app.checklists (id) ON DELETE CASCADE,
    texto         text NOT NULL,
    ordem         int NOT NULL DEFAULT 0,
    ativo         boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS fin_app.checklist_pessoas (
    checklist_id  uuid NOT NULL REFERENCES fin_app.checklists (id) ON DELETE CASCADE,
    usuario_id    uuid NOT NULL REFERENCES fin_app.usuarios (id) ON DELETE CASCADE,
    PRIMARY KEY (checklist_id, usuario_id)
);
-- o checklist de um dia
CREATE TABLE IF NOT EXISTS fin_app.checklist_execucoes (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checklist_id         uuid NOT NULL REFERENCES fin_app.checklists (id) ON DELETE CASCADE,
    data                 date NOT NULL,
    finalizada_em        timestamptz,
    finalizada_por_nome  text,
    motivo               text,              -- por que algo ficou sem fazer
    ciente_em            timestamptz,       -- o admin viu o aviso
    UNIQUE (checklist_id, data)
);
CREATE TABLE IF NOT EXISTS fin_app.checklist_marcas (
    execucao_id    uuid NOT NULL REFERENCES fin_app.checklist_execucoes (id) ON DELETE CASCADE,
    item_id        uuid NOT NULL REFERENCES fin_app.checklist_itens (id) ON DELETE CASCADE,
    feito_em       timestamptz NOT NULL DEFAULT now(),
    feito_por_nome text,
    PRIMARY KEY (execucao_id, item_id)
);

RESET ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.checklists, fin_app.checklist_itens, fin_app.checklist_pessoas,
      fin_app.checklist_execucoes, fin_app.checklist_marcas TO fin_app_rw;
