-- Pessoas: exclusão (com lista de excluídos que vieram do Nibo, para não voltarem na importação),
-- área do free lance (cozinha / salão) e banco de candidatos do RH (com currículo). Idempotente.

SET ROLE fin_app_owner;

ALTER TABLE fin_app.pessoas ADD COLUMN IF NOT EXISTS free_lance_areas text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'free_lance_areas_validas') THEN
    ALTER TABLE fin_app.pessoas ADD CONSTRAINT free_lance_areas_validas CHECK (free_lance_areas <@ ARRAY['cozinha', 'salao']::text[]);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fin_app.pessoas_excluidas (
    nibo_id      uuid PRIMARY KEY,
    nome         text NOT NULL,
    excluido_em  timestamptz NOT NULL DEFAULT now(),
    excluido_por uuid
);

-- Banco de candidatos (processos seletivos): contato, áreas de interesse, avaliação e currículo
CREATE TABLE IF NOT EXISTS fin_app.rh_candidatos (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome             text NOT NULL,
    telefone         text,
    email            text,
    cidade           text,
    areas            text[] NOT NULL DEFAULT '{}'
                     CHECK (areas <@ ARRAY['cozinha', 'salao', 'bar', 'caixa', 'delivery', 'limpeza', 'administrativo']::text[]),
    disponibilidade  text,
    pretensao        numeric(14,2) CHECK (pretensao >= 0),
    origem           text,
    ultimo_contato   date,
    status           text NOT NULL DEFAULT 'disponivel'
                     CHECK (status IN ('disponivel', 'contratado', 'sem_interesse', 'nao_recomendado')),
    avaliacao        smallint CHECK (avaliacao BETWEEN 1 AND 5),
    observacao       text,
    curriculo        text,          -- caminho em ANEXOS_DIR/rh/candidatos
    curriculo_nome   text,
    curriculo_tipo   text,
    criado_em        timestamptz NOT NULL DEFAULT now(),
    atualizado_em    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rh_candidatos_status_idx ON fin_app.rh_candidatos (status);

RESET ROLE;

GRANT SELECT, INSERT ON fin_app.pessoas_excluidas TO fin_app_rw;
GRANT DELETE ON fin_app.pessoas TO fin_app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.rh_candidatos TO fin_app_rw;

CREATE OR REPLACE FUNCTION fin_app.importar_nibo()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'fin_app', 'pg_temp'
AS $function$
DECLARE n_contas int; n_cat int; n_sub int; n_pes int;
BEGIN
  INSERT INTO fin_app.contas_bancarias (id, nome, tipo, banco, saldo_inicial, data_saldo_inicial, ativo, nibo_id)
  SELECT a.id, a.name, CASE a.type WHEN 'CashAccount' THEN 'dinheiro' ELSE 'banco' END, a.bank_name,
         coalesce(a.open_balance, 0), a.open_balance_date, NOT coalesce(a.is_archived, false), a.id
  FROM raw.nibo_accounts a
  WHERE NOT EXISTS (SELECT 1 FROM fin_app.contas_bancarias c WHERE c.nibo_id = a.id OR c.nome = a.name);
  GET DIAGNOSTICS n_contas = ROW_COUNT;

  INSERT INTO fin_app.categorias (nome, grupo_fluxo, nibo_ref, ordem)
  SELECT DISTINCT ON (ref) nome, fluxo, ref, ordem FROM (
    SELECT c.group_name || '|' || coalesce(nullif(c.subgroup_name, ''), '') AS ref,
           CASE WHEN nullif(c.subgroup_name, '') IS NOT NULL THEN fin_app._titulo(c.subgroup_name)
                ELSE CASE c.group_name
                       WHEN 'Atividades de financiamento' THEN 'Financiamento e capital'
                       WHEN 'Atividades de investimento' THEN 'Investimentos diversos'
                       WHEN 'Custos operacionais' THEN 'Custos operacionais diversos'
                       WHEN 'Receitas operacionais' THEN 'Outras receitas operacionais'
                       ELSE 'Despesas diversas' END END AS nome,
           CASE WHEN c.group_name ILIKE '%investimento%' THEN 'investimento'
                WHEN c.group_name ILIKE '%financiamento%' THEN 'financiamento' ELSE 'operacional' END AS fluxo,
           CASE WHEN c.group_name ILIKE 'Receitas%' THEN 10 WHEN c.group_name ILIKE 'Custos%' THEN 20
                WHEN c.group_name ILIKE 'Despesas%' THEN 30 WHEN c.group_name ILIKE '%investimento%' THEN 40
                ELSE 50 END AS ordem
    FROM raw.nibo_categories c) x
  WHERE NOT EXISTS (SELECT 1 FROM fin_app.categorias k WHERE k.nibo_ref = x.ref OR k.nome = x.nome)
  ORDER BY ref;
  GET DIAGNOSTICS n_cat = ROW_COUNT;

  INSERT INTO fin_app.subcategorias (id, categoria_id, nome, tipo, codigo, nibo_id)
  SELECT c.id, k.id, c.name, CASE c.type WHEN 'in' THEN 'receber' ELSE 'pagar' END, nullif(c.reference_code, ''), c.id
  FROM raw.nibo_categories c
  JOIN fin_app.categorias k ON k.nibo_ref = c.group_name || '|' || coalesce(nullif(c.subgroup_name, ''), '')
  WHERE NOT EXISTS (SELECT 1 FROM fin_app.subcategorias s WHERE s.nibo_id = c.id)
  ON CONFLICT (categoria_id, nome) DO NOTHING;
  GET DIAGNOSTICS n_sub = ROW_COUNT;

  INSERT INTO fin_app.pessoas (id, nome, papeis, tipo_pessoa, documento, telefone, email, ativo, nibo_id)
  SELECT s.id, s.name,
         ARRAY[CASE s.type WHEN 'Supplier' THEN 'fornecedor' WHEN 'Customer' THEN 'cliente'
                           WHEN 'Employee' THEN 'funcionario' ELSE 'socio' END],
         CASE WHEN s.raw->'document'->>'type' = 'Cnpj' THEN 'PJ' WHEN s.raw->'document'->>'type' = 'Cpf' THEN 'PF' END,
         s.raw->'document'->>'number',
         coalesce(s.raw->'communication'->>'cellPhone', s.raw->'communication'->>'phone'),
         s.raw->'communication'->>'email',
         NOT (coalesce(s.is_deleted, false) OR coalesce(s.is_archived, false)), s.id
  FROM raw.nibo_stakeholders s
  WHERE s.name IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_app.pessoas p WHERE p.nibo_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM fin_app.pessoas_excluidas x WHERE x.nibo_id = s.id);   -- excluídos no app não voltam
  GET DIAGNOSTICS n_pes = ROW_COUNT;

  RETURN jsonb_build_object('contas', n_contas, 'categorias', n_cat, 'subcategorias', n_sub, 'pessoas', n_pes);
END $function$;
