-- Nome da forma de pagamento na planilha antiga de fechamento (quando é diferente do nome no app).
-- Usado só na comparação app × planilha e no "Copiar da planilha".
alter table fin_app.formas_pagamento add column if not exists nome_planilha text;
update fin_app.formas_pagamento set nome_planilha = x.p from (values
  ('Crédito Pag Seguro', 'Crédito'), ('Débito Pag Seguro', 'Débito'), ('Pix Pag Seguro', 'Pix Máquina Cartão'),
  ('Pgto Online Aiqfome', 'Aiqfome'), ('Pgto Online Anota Aí', 'Anota Aí')) x(n, p)
where nome = x.n and nome_planilha is null;
