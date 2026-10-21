-- Afazeres: conferência do fechamento de caixa pelo admin e tarefas manuais (para si ou atribuídas a alguém da equipe).
-- As tarefas automáticas (conferir caixa, conciliar notas, fechar caixa, contar estoque) são calculadas na hora. Idempotente.
SET ROLE fin_app_owner;

ALTER TABLE fin_app.caixa_dia ADD COLUMN IF NOT EXISTS conferido_em   timestamptz;
ALTER TABLE fin_app.caixa_dia ADD COLUMN IF NOT EXISTS conferido_por  uuid REFERENCES fin_app.usuarios (id);
ALTER TABLE fin_app.caixa_dia ADD COLUMN IF NOT EXISTS conferido_nome text;

CREATE TABLE IF NOT EXISTS fin_app.tarefas (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    titulo           text NOT NULL,
    descricao        text,
    prazo            date,
    responsavel_id   uuid NOT NULL REFERENCES fin_app.usuarios (id) ON DELETE CASCADE,
    criado_por       uuid REFERENCES fin_app.usuarios (id) ON DELETE SET NULL,
    criado_por_nome  text,
    criado_em        timestamptz NOT NULL DEFAULT now(),
    concluida_em     timestamptz,
    concluida_por_nome text
);
CREATE INDEX IF NOT EXISTS tarefas_resp_idx ON fin_app.tarefas (responsavel_id, concluida_em);
CREATE INDEX IF NOT EXISTS tarefas_criador_idx ON fin_app.tarefas (criado_por, concluida_em);

RESET ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.tarefas TO fin_app_rw;
GRANT UPDATE (conferido_em, conferido_por, conferido_nome) ON fin_app.caixa_dia TO fin_app_rw;
