-- Login com perfis (admin / responsável de caixa / funcionário) e módulo de RH:
-- ficha do funcionário, ponto (controle interno), vales/consumos e holerites. Idempotente; rodar como superusuário.

SET ROLE fin_app_owner;

-- ------------------------------------------------------------------ acesso
CREATE TABLE IF NOT EXISTS fin_app.usuarios (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pessoa_id           uuid UNIQUE REFERENCES fin_app.pessoas (id),
    cpf                 text NOT NULL UNIQUE CHECK (cpf ~ '^\d{11}$'),
    nome                text NOT NULL,
    perfil              text NOT NULL CHECK (perfil IN ('admin', 'responsavel_caixa', 'funcionario')),
    senha_hash          text,                    -- scrypt; NULL até o primeiro acesso
    convite_hash        text,                    -- sha256 do token do link de primeiro acesso
    convite_expira      timestamptz,
    ativo               boolean NOT NULL DEFAULT true,
    falhas              int NOT NULL DEFAULT 0,
    bloqueado_ate       timestamptz,
    ultimo_login        timestamptz,
    criado_em           timestamptz NOT NULL DEFAULT now(),
    atualizado_em       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_app.sessoes (
    token_hash   text PRIMARY KEY,               -- sha256 do token do cookie (o token em si não é guardado)
    usuario_id   uuid NOT NULL REFERENCES fin_app.usuarios (id),
    criada_em    timestamptz NOT NULL DEFAULT now(),
    expira_em    timestamptz NOT NULL,
    ip           text,
    agente       text
);
CREATE INDEX IF NOT EXISTS sessoes_usuario_idx ON fin_app.sessoes (usuario_id);

CREATE TABLE IF NOT EXISTS fin_app.acessos_log (
    id          bigserial PRIMARY KEY,
    usuario_id  uuid,
    cpf         text,
    evento      text NOT NULL,                   -- login_ok, login_falha, bloqueio, logout, convite, senha_definida
    ip          text,
    em          timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ RH
CREATE TABLE IF NOT EXISTS fin_app.rh_funcionarios (
    pessoa_id        uuid PRIMARY KEY REFERENCES fin_app.pessoas (id),
    cpf              text CHECK (cpf IS NULL OR cpf ~ '^\d{11}$'),
    cargo            text,
    vinculo          text NOT NULL DEFAULT 'clt' CHECK (vinculo IN ('clt', 'free_lance', 'estagio', 'socio', 'outro')),
    admissao         date,
    desligamento     date,
    salario          numeric(14,2),
    jornada_semanal  numeric(5,2) DEFAULT 44,
    observacao       text,
    criado_em        timestamptz NOT NULL DEFAULT now(),
    atualizado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_app.rh_ponto (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pessoa_id     uuid NOT NULL REFERENCES fin_app.pessoas (id),
    momento       timestamptz NOT NULL DEFAULT now(),   -- hora do servidor, não do celular
    tipo          text NOT NULL CHECK (tipo IN ('entrada', 'saida')),
    lat           numeric(9,6),
    lng           numeric(9,6),
    precisao_m    numeric(8,1),
    foto          text,                                 -- caminho relativo em ANEXOS_DIR/ponto
    origem        text NOT NULL DEFAULT 'portal' CHECK (origem IN ('portal', 'ajuste')),
    motivo        text,                                 -- obrigatório nos ajustes
    registrado_por uuid REFERENCES fin_app.usuarios (id),
    cancelado_em  timestamptz,
    cancelado_por uuid REFERENCES fin_app.usuarios (id)
);
CREATE INDEX IF NOT EXISTS rh_ponto_pessoa_idx ON fin_app.rh_ponto (pessoa_id, momento);

CREATE TABLE IF NOT EXISTS fin_app.rh_lancamentos (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pessoa_id     uuid NOT NULL REFERENCES fin_app.pessoas (id),
    tipo          text NOT NULL CHECK (tipo IN ('vale', 'consumo', 'adiantamento', 'desconto', 'bonus')),
    data          date NOT NULL,
    competencia   date NOT NULL,                        -- 1º dia do mês em que será descontado/pago
    valor         numeric(14,2) NOT NULL CHECK (valor > 0),
    descricao     text,
    status        text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'descontado')),
    criado_por    uuid REFERENCES fin_app.usuarios (id),
    cancelado_em  timestamptz,
    criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rh_lanc_pessoa_idx ON fin_app.rh_lancamentos (pessoa_id, competencia);

CREATE TABLE IF NOT EXISTS fin_app.rh_documentos (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pessoa_id     uuid NOT NULL REFERENCES fin_app.pessoas (id),
    tipo          text NOT NULL DEFAULT 'holerite' CHECK (tipo IN ('holerite', 'ferias', 'decimo_terceiro', 'contrato', 'outro')),
    competencia   date,
    nome          text NOT NULL,
    arquivo       text NOT NULL,                        -- caminho relativo em ANEXOS_DIR/rh
    sha256        text NOT NULL,
    enviado_por   uuid REFERENCES fin_app.usuarios (id),
    visto_em      timestamptz,                          -- quando o funcionário abriu
    cancelado_em  timestamptz,
    criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rh_docs_pessoa_idx ON fin_app.rh_documentos (pessoa_id, competencia);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON fin_app.usuarios, fin_app.rh_funcionarios, fin_app.rh_ponto,
                                fin_app.rh_lancamentos, fin_app.rh_documentos TO fin_app_rw;
GRANT SELECT, INSERT, DELETE ON fin_app.sessoes TO fin_app_rw;
GRANT SELECT, INSERT ON fin_app.acessos_log TO fin_app_rw;
GRANT USAGE ON SEQUENCE fin_app.acessos_log_id_seq TO fin_app_rw;
