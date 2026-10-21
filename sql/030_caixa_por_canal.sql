-- Salão e delivery fecham separados (computadores, pessoas e horários diferentes).
-- O dia fica "fechado" quando os dois canais estão fechados.
alter table fin_app.caixa_canal
  add column if not exists status text not null default 'rascunho' check (status in ('rascunho', 'fechado')),
  add column if not exists fechado_em timestamptz,
  add column if not exists fechado_por text;
update fin_app.caixa_canal k set status = 'fechado', fechado_em = d.fechado_em
from fin_app.caixa_dia d where d.data = k.data and d.status = 'fechado' and k.status = 'rascunho';
grant update (status, fechado_em, fechado_por) on fin_app.caixa_canal to fin_app_rw;

-- Cartão, pix direto e apps somam os dois canais: quem confere é o administrador (na conferência do dia).
update fin_app.formas_pagamento set conferir_no_caixa = true where conferencia <> 'gaveta';
