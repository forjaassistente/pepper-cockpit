-- Fechamento de caixa feito no app (em paralelo com a planilha). Idempotente; rodar como superusuário.
-- Fase atual: o cockpit (views bi.*) continua lendo a planilha; estas tabelas só alimentam a tela
-- de fechamento e a comparação com a planilha. A "virada" para o cockpit é um passo separado.

GRANT SELECT ON raw.caixa_dia, raw.caixa_recebimentos, raw.caixa_pagamentos_equipe,
                raw.caixa_conferencia, raw.dias_fechados TO fin_app_owner;

SET ROLE fin_app_owner;

-- Um registro por dia: status do fechamento.
CREATE TABLE IF NOT EXISTS fin_app.caixa_dia (
    data           date PRIMARY KEY,
    status         text NOT NULL CHECK (status IN ('rascunho', 'fechado', 'nao_abriu')),
    motivo         text,                    -- quando não abriu
    fechado_em     timestamptz,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- Cabeçalho de cada canal (Salão / Delivery) no dia.
CREATE TABLE IF NOT EXISTS fin_app.caixa_canal (
    data                 date NOT NULL REFERENCES fin_app.caixa_dia (data),
    canal                text NOT NULL CHECK (canal IN ('Salão', 'Delivery')),
    responsavel          text,
    troco_inicial        numeric(14,2) NOT NULL DEFAULT 0,
    fechamento_dinheiro  numeric(14,2),
    diversos             numeric(14,2) NOT NULL DEFAULT 0,
    observacao           text,
    PRIMARY KEY (data, canal)
);

CREATE TABLE IF NOT EXISTS fin_app.caixa_formas (
    data   date NOT NULL,
    canal  text NOT NULL,
    forma  text NOT NULL CHECK (forma IN ('Dinheiro', 'Débito', 'Crédito', 'Pix Máquina Cartão',
                                          'Pix Direto', 'Aiqfome', 'Anota Aí')),
    valor  numeric(14,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
    PRIMARY KEY (data, canal, forma),
    FOREIGN KEY (data, canal) REFERENCES fin_app.caixa_canal (data, canal) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fin_app.caixa_equipe (
    data   date NOT NULL,
    canal  text NOT NULL,
    linha  int  NOT NULL,
    nome   text NOT NULL,
    valor  numeric(14,2) NOT NULL CHECK (valor >= 0),
    PRIMARY KEY (data, canal, linha),
    FOREIGN KEY (data, canal) REFERENCES fin_app.caixa_canal (data, canal) ON DELETE CASCADE
);

-- Valor real conferido (gaveta, relatório da maquininha, apps). O "deve ter" é calculado.
CREATE TABLE IF NOT EXISTS fin_app.caixa_conferencia (
    data        date NOT NULL REFERENCES fin_app.caixa_dia (data),
    item        text NOT NULL,
    valor_real  numeric(14,2),
    PRIMARY KEY (data, item)
);

-- Foto de cada gravação (o app substitui os detalhes do dia a cada salvamento).
CREATE TABLE IF NOT EXISTS fin_app.caixa_historico (
    id      bigserial PRIMARY KEY,
    data    date NOT NULL,
    acao    text NOT NULL,
    dados   jsonb NOT NULL,
    em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS caixa_historico_data_idx ON fin_app.caixa_historico (data, em);

-- Planilha (só leitura) no mesmo formato, para a comparação lado a lado.
CREATE OR REPLACE VIEW fin_app.v_planilha_caixa AS
SELECT d.data, d.canal, d.responsavel, d.troco_inicial, d.fechamento_dinheiro,
       d.pagamento_equipe, d.diversos, d.total, d.soma_formas, d.observacao
FROM raw.caixa_dia d;

CREATE OR REPLACE VIEW fin_app.v_planilha_formas AS
SELECT data, canal, forma_pagamento AS forma, valor FROM raw.caixa_recebimentos;

CREATE OR REPLACE VIEW fin_app.v_planilha_equipe AS
SELECT data, canal, linha, nome, valor FROM raw.caixa_pagamentos_equipe;

CREATE OR REPLACE VIEW fin_app.v_planilha_conferencia AS
SELECT data, item, deve_ter, valor_real, diferenca FROM raw.caixa_conferencia;

CREATE OR REPLACE VIEW fin_app.v_dias_fechados AS
SELECT data, motivo FROM raw.dias_fechados;

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON fin_app.caixa_dia TO fin_app_rw;
-- Os detalhes do dia são regravados a cada salvamento (o histórico guarda cada versão).
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.caixa_canal, fin_app.caixa_formas, fin_app.caixa_equipe,
                                        fin_app.caixa_conferencia TO fin_app_rw;
GRANT SELECT, INSERT ON fin_app.caixa_historico TO fin_app_rw;
GRANT USAGE ON SEQUENCE fin_app.caixa_historico_id_seq TO fin_app_rw;
GRANT SELECT ON fin_app.v_planilha_caixa, fin_app.v_planilha_formas, fin_app.v_planilha_equipe,
                fin_app.v_planilha_conferencia, fin_app.v_dias_fechados TO fin_app_rw;
