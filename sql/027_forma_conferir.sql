-- Forma de pagamento entra (ou não) na conferência "deve ter" do fechamento de caixa.
-- PagSeguro, Aiqfome e Anota Aí: os valores de cima já dizem tudo, não precisam de conferência separada.
alter table fin_app.formas_pagamento add column if not exists conferir_no_caixa boolean not null default true;
update fin_app.formas_pagamento set conferir_no_caixa = false
where conferencia in ('App PagSeguro', 'App Geraldo Aiqfome', 'App Anota Aí', 'App Sicoob');
