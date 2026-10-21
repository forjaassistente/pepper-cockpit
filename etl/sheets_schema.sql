-- Pepper BI · Planilhas Google (Fechamento de Caixa + Fechamento das entregas)
-- raw.* = cópia fiel das abas diárias (escrita só pelo bi_etl)
-- bi.*  = views para o Metabase (lidas pelo bi_reader)
-- Idempotente: roda no início de cada carga, na mesma transação dos dados.

-- Um registro por dia × canal (aba diária do Fechamento de Caixa)
CREATE TABLE IF NOT EXISTS raw.caixa_dia (
    data                 date NOT NULL,
    canal                text NOT NULL,       -- Salão / Delivery
    aba                  text NOT NULL,
    responsavel          text,
    troco_inicial        numeric(14,2),
    fechamento_dinheiro  numeric(14,2),
    pagamento_equipe     numeric(14,2),       -- free lances (salão) / motoboys (delivery)
    diversos             numeric(14,2),
    total                numeric(14,2),       -- "FECHAMENTO TOTAL" digitado/calculado na aba (só auditoria)
    soma_formas          numeric(14,2),       -- soma das formas de pagamento = TOTAL GERAL do resumo (valor OFICIAL)
    observacao           text,
    loaded_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (data, canal)
);

CREATE TABLE IF NOT EXISTS raw.caixa_recebimentos (
    data            date NOT NULL,
    canal           text NOT NULL,
    forma_pagamento text NOT NULL,
    valor           numeric(14,2) NOT NULL,
    PRIMARY KEY (data, canal, forma_pagamento)
);

-- Bloco "CAIXA / CONFERÊNCIA / VALOR REAL / DIFERENÇA" do resumo diário
CREATE TABLE IF NOT EXISTS raw.caixa_conferencia (
    data        date NOT NULL,
    item        text NOT NULL,
    deve_ter    numeric(14,2),
    valor_real  numeric(14,2),
    diferenca   numeric(14,2),
    PRIMARY KEY (data, item)
);

-- "DETALHE FREE LANCES" / "DETALHE MOTOBOYS"
CREATE TABLE IF NOT EXISTS raw.caixa_pagamentos_equipe (
    data   date NOT NULL,
    canal  text NOT NULL,
    linha  int  NOT NULL,
    nome   text,
    valor  numeric(14,2),
    PRIMARY KEY (data, canal, linha)
);

-- Uma linha por comanda da planilha de entregas (controle interno; faturamento oficial = Caixa)
CREATE TABLE IF NOT EXISTS raw.entregas_comandas (
    data            date NOT NULL,
    aba             text NOT NULL,
    linha           int  NOT NULL,
    numero          text,
    valor_comanda   numeric(14,2),
    valor_entrega   numeric(14,2),
    aplicativo      text,
    forma_pagamento text,
    entregador      text,
    observacao      text,
    loaded_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (data, linha)
);

-- Dias fechados fora as segundas. Mantida À MÃO (a carga não apaga esta tabela).
-- Para incluir um dia: INSERT INTO raw.dias_fechados VALUES ('2026-12-25', 'Natal');
CREATE TABLE IF NOT EXISTS raw.dias_fechados (
    data   date PRIMARY KEY,
    motivo text NOT NULL
);
INSERT INTO raw.dias_fechados VALUES
    ('2026-04-21', 'Não abriu (Tiradentes)'),
    ('2026-07-21', 'Reforma'),
    ('2026-09-11', 'Enchente na cidade')
ON CONFLICT (data) DO NOTHING;

-- ---------------------------------------------------------------- views bi
-- Recriadas a cada carga. Sem CASCADE: se alguém criar view própria em cima, a carga falha em vez de apagá-la.
DROP VIEW IF EXISTS bi.media_dia_semana, bi.faturamento_dia, bi.vendas_forma_pagamento,
    bi.conferencia_delivery, bi.entregas_comandas, bi.calendario;

-- Todos os dias de 01/03/2026 até o último dia com venda, com status aberto/fechado.
CREATE VIEW bi.calendario AS
WITH limites AS (
    SELECT date '2026-03-01' AS ini, max(data) AS fim
    FROM raw.caixa_dia WHERE soma_formas > 0
), tot AS (
    SELECT data, sum(soma_formas) AS total,
           string_agg(NULLIF(observacao, ''), ' | ') AS obs
    FROM raw.caixa_dia GROUP BY data
)
SELECT
    d::date                                             AS data,
    extract(isodow FROM d)::int                         AS dia_semana_num,   -- 1=seg … 7=dom
    (ARRAY['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'])[extract(isodow FROM d)::int]
                                                        AS dia_semana,
    to_char(d, 'YYYY-MM')                               AS mes,
    date_trunc('week', d)::date                         AS semana_inicio,
    CASE
        WHEN f.data IS NOT NULL               THEN false
        WHEN extract(isodow FROM d) = 1       THEN false
        WHEN COALESCE(t.total, 0) = 0         THEN false
        ELSE true
    END                                                 AS aberto,
    CASE
        WHEN f.data IS NOT NULL               THEN f.motivo
        WHEN extract(isodow FROM d) = 1       THEN 'Segunda (fechado)'
        WHEN t.data IS NULL                   THEN 'Sem fechamento lançado'
        WHEN COALESCE(t.total, 0) = 0         THEN COALESCE(t.obs, 'Sem venda')
    END                                                 AS motivo_fechado
FROM limites l
CROSS JOIN generate_series(l.ini, l.fim, interval '1 day') d
LEFT JOIN raw.dias_fechados f ON f.data = d::date
LEFT JOIN tot t ON t.data = d::date;

-- Faturamento por dia (só dias abertos): salão, delivery, total e mix de canal
CREATE VIEW bi.faturamento_dia AS
SELECT
    c.data, c.dia_semana_num, c.dia_semana, c.mes, c.semana_inicio,
    COALESCE(s.soma_formas, 0)                                AS salao,
    COALESCE(dl.soma_formas, 0)                               AS delivery,
    COALESCE(s.soma_formas, 0) + COALESCE(dl.soma_formas, 0)        AS total,
    round(100 * COALESCE(s.soma_formas, 0)  / NULLIF(COALESCE(s.soma_formas, 0) + COALESCE(dl.soma_formas, 0), 0), 1) AS pct_salao,
    round(100 * COALESCE(dl.soma_formas, 0) / NULLIF(COALESCE(s.soma_formas, 0) + COALESCE(dl.soma_formas, 0), 0), 1) AS pct_delivery
FROM bi.calendario c
LEFT JOIN raw.caixa_dia s  ON s.data  = c.data AND s.canal  = 'Salão'
LEFT JOIN raw.caixa_dia dl ON dl.data = c.data AND dl.canal = 'Delivery'
WHERE c.aberto;

-- Média por dia da semana, só dias abertos (dias fechados não entram como zero)
CREATE VIEW bi.media_dia_semana AS
SELECT dia_semana_num, dia_semana,
       count(*)                     AS dias_considerados,
       round(avg(total), 2)         AS media_total,
       round(avg(salao), 2)         AS media_salao,
       round(avg(delivery), 2)      AS media_delivery,
       round(100 * sum(salao)    / NULLIF(sum(total), 0), 1) AS pct_salao,
       round(100 * sum(delivery) / NULLIF(sum(total), 0), 1) AS pct_delivery
FROM bi.faturamento_dia
GROUP BY dia_semana_num, dia_semana;

-- Dia × canal × forma de pagamento (só dias abertos)
CREATE VIEW bi.vendas_forma_pagamento AS
SELECT c.data, c.dia_semana_num, c.dia_semana, c.mes, c.semana_inicio,
       r.canal, r.forma_pagamento, r.valor
FROM raw.caixa_recebimentos r
JOIN bi.calendario c ON c.data = r.data AND c.aberto
WHERE r.valor <> 0;

CREATE VIEW bi.entregas_comandas AS
SELECT e.data, c.dia_semana_num, c.dia_semana, c.mes,
       e.numero, e.valor_comanda, e.valor_entrega, e.aplicativo,
       e.forma_pagamento, e.entregador, e.observacao
FROM raw.entregas_comandas e
LEFT JOIN bi.calendario c ON c.data = e.data;

-- Caixa (oficial) × planilha de entregas (controle interno), por dia
CREATE VIEW bi.conferencia_delivery AS
SELECT c.data, c.dia_semana,
       cd.soma_formas                                   AS delivery_caixa,
       e.soma                                     AS delivery_entregas,
       e.comandas,
       e.soma - cd.soma_formas                          AS diferenca
FROM bi.calendario c
JOIN raw.caixa_dia cd ON cd.data = c.data AND cd.canal = 'Delivery'
JOIN (SELECT data, sum(valor_comanda) AS soma, count(*) AS comandas
      FROM raw.entregas_comandas GROUP BY data) e ON e.data = c.data;
