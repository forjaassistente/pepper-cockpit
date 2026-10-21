-- Fechamento de caixa → fluxo de caixa (contas recebidas / a receber / pagas).
-- Cada forma de pagamento diz em que conta cai e em que categoria entra; o lançamento é agrupado
-- pelo grupo de conferência (ex.: débito + crédito + pix da PagSeguro = "Recebimento máquina cartão").
alter table fin_app.formas_pagamento
  add column if not exists conta_id uuid,             -- v_contas.id (Nibo)
  add column if not exists categoria_id uuid,         -- v_categorias.id (receber)
  add column if not exists descricao_lanc text;       -- ex.: "Recebimento máquina cartão"

-- Modo teste: o lançamento só é guardado e comparado com o Nibo (não entra no fluxo).
alter table fin_app.empresa add column if not exists caixa_fluxo_teste boolean not null default true;

-- O que o fechamento do dia gera (confirmado pelo admin). lancamento_id fica nulo no modo teste.
create table if not exists fin_app.caixa_fluxo (
  id              uuid primary key default gen_random_uuid(),
  data            date not null references fin_app.caixa_dia (data) on delete cascade,
  ordem           int not null,
  chave           text not null,                    -- forma:App PagSeguro | equipe:Delivery | freelance:Salão:Andreza | diversos:Salão
  tipo            text not null check (tipo in ('pagar', 'receber')),
  descricao       text not null,
  contato         text,
  contato_id      uuid references fin_app.pessoas (id),
  valor           numeric(14,2) not null check (valor > 0),
  categoria_id    uuid,
  categoria_nome  text,
  conta_id        uuid,
  conta_nome      text,
  quitado         boolean not null,                 -- recebido / pago
  vencimento      date not null,
  lancamento_id   uuid references fin_app.lancamentos (id),
  confirmado_em   timestamptz not null default now(),
  confirmado_por  text,
  unique (data, chave)
);
grant select, insert, update, delete on fin_app.caixa_fluxo to fin_app_rw;
grant update (conta_id, categoria_id, descricao_lanc) on fin_app.formas_pagamento to fin_app_rw;
grant update (caixa_fluxo_teste) on fin_app.empresa to fin_app_rw;

-- sugestão inicial (revisável em Cadastros › Formas de pagamento)
update fin_app.formas_pagamento f set descricao_lanc = x.d,
  categoria_id = coalesce(f.categoria_id, (select id from fin_app.v_categorias where categoria = x.cat and tipo = 'receber' limit 1)),
  conta_id = coalesce(f.conta_id, (select id from fin_app.v_contas where conta = x.conta limit 1))
from (values
  ('gaveta',              'Recebimento dinheiro',        'Receita por dinheiro em espécie',           'Caixa (Dinheiro) - DESP. OP.'),
  ('App PagSeguro',       'Recebimento máquina cartão',  'Receita por máquina de cartão',             'Pagseguro - RECEITAS'),
  ('App Sicoob',          'Recebimento pix',             'Receita por pix direto',                    'Sicoob - DESP. OP.'),
  ('App Geraldo Aiqfome', 'Recebimento aiqfome',         'Receita por pagamento on-line aplicativos', null),
  ('App Anota Aí',        'Recebimento anota aí',        'Receita por pagamento on-line aplicativos', null)
) x(conf, d, cat, conta)
where f.conferencia = x.conf and f.descricao_lanc is null;
