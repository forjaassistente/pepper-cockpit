// Conciliação de notas de compra: cada item da nota → insumo + conversão de unidade.
// Ao salvar: entrada no estoque, histórico de preço e último preço pago no insumo (compras.py).
// Abre por #/conciliar?doc=<documento da Caixa de entrada> ou #/conciliar?id=<compra>.

const UN_DA_NOTA = { KG: 'kg', KGS: 'kg', G: 'g', GR: 'g', L: 'l', LT: 'l', LTS: 'l', ML: 'ml', UN: 'un', UND: 'un', UNID: 'un',
  PC: 'un', PCA: 'un', CX: 'cx', PCT: 'pct', PT: 'pct', DZ: 'dz', FD: 'fardo', M: 'm' };
const SITUACAO_ITEM = {
  conciliado: ['ok', 'conciliado'], vinculo: ['ok', 'reconhecido'], sugestao: ['sug', 'sugestão — confira'],
  pendente: ['pend', 'escolha o insumo'], ignorado: ['ign', 'não é insumo'], novo: ['pend', 'item digitado'],
};

// Mesma regra de compras.fator_sugerido: quantas unidades do insumo vêm em 1 unidade da nota
const MEDIDA_UN = { kg: ['kg', 1], g: ['kg', 0.001], l: ['l', 1], ml: ['l', 0.001] };
const UN_TXT = { kg: 'kg', g: 'g', gr: 'g', l: 'l', lt: 'l', ml: 'ml' };
function fatorDaDescricao(desc, unNota, unIns) {
  const un = UN_DA_NOTA[(unNota || '').toUpperCase()] || (unNota || '').toLowerCase();
  const direto = converterUn(1, un, unIns);
  if (direto != null) return direto;
  const d = normBusca(desc).replace(/,/g, '.');
  const pack = d.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|gr|g|lt|l|ml)\b/), tam = d.match(/(\d+(?:\.\d+)?)\s*(kg|gr|g|lt|l|ml)\b/);
  const qtd = d.match(/(?:\bc\s*\/?\s*|com\s+)(\d+)\b|\b(\d+)\s*(?:un|und|unid|unidades)\b/);
  if (MEDIDA_UN[unIns]) {
    const [n, v, u] = pack ? [Number(pack[1]), Number(pack[2]), UN_TXT[pack[3]]] : tam ? [1, Number(tam[1]), UN_TXT[tam[2]]] : [];
    if (!u || MEDIDA_UN[u][0] !== MEDIDA_UN[unIns][0]) return null;
    return Math.round(n * v * MEDIDA_UN[u][1] / MEDIDA_UN[unIns][1] * 1e6) / 1e6;
  }
  if (unIns === 'un') return pack ? Number(pack[1]) : qtd ? Number(qtd[1] || qtd[2]) : null;
  return null;
}

PAGES['conciliar'] = {
  eyebrow: 'Caixa de entrada', title: 'Conciliar nota', lede: 'Ligue cada item da nota a um insumo: dá entrada no estoque e atualiza o preço.', periodo: false,
  async render(v, p) {
    if (p.doc && !p.id) {   // primeira vez: cria a compra a partir do documento (não mexe no financeiro)
      const r = await send('POST', `compras/de-documento/${p.doc}`);
      location.replace(`#/conciliar?id=${r.id}`);
      return;
    }
    const flash = FLASH; FLASH = '';
    v.innerHTML = `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}<section id="cc-box" class="view"></section>`;
    await telaConciliacao(v.querySelector('#cc-box'), p.id);
  },
};

async function telaConciliacao(box, cid) {
  const r = await api(`compras/${cid}`);
  const c = r.compra, xml = c.origem === 'nfe_xml';
  const insumos = r.insumos;
  const porId = Object.fromEntries(insumos.map(i => [i.id, i]));
  const grupos = {};
  insumos.forEach(i => (grupos[i.categoria || 'Sem categoria'] ||= []).push(i));
  const opIns = sel => `<option value="">— Escolha o insumo —</option>` + Object.entries(grupos).map(([g, is]) =>
    `<optgroup label="${esc(g)}">${is.map(i => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.nome)} (${i.unidade})</option>`).join('')}</optgroup>`).join('');
  const total = Number(c.valor_total || 0);
  document.getElementById('title').textContent = `Conciliar ${xml ? 'NF' : 'nota'} ${c.numero ? esc(c.numero) : ''}`.trim();

  if (c.finalidade) {   // nota de débito/ajuste/devolução: repete itens de outra nota, mas o valor não é preço de compra
    box.innerHTML = `<div class="card cc-cab">
        <div><small>Fornecedor</small><b>${esc(c.emitente_nome || '—')}</b><span class="muted">${c.fornecedor_cadastro ? `cadastro: ${esc(c.fornecedor_cadastro)}` : 'sem cadastro ligado'}</span></div>
        <div><small>Nota</small><b>NF ${esc(c.numero || '—')}${c.serie ? ` · série ${esc(c.serie)}` : ''}</b><span class="muted">emitida ${c.emissao ? dm(c.emissao) + '/' + c.emissao.slice(0, 4) : '—'}</span></div>
        <div><small>Total da nota</small><b>${money(total)}</b><span class="muted">${c.no_financeiro ? 'Já lançada em contas a pagar.' : 'Ainda não lançada no financeiro.'}</span></div>
        <div class="cc-links">${c.documento_id ? `<a class="btn sm" href="/api/inbox/${c.documento_id}/arquivo" target="_blank" rel="noopener">Ver arquivo ↗</a>` : ''}</div></div>
      <div class="alert warn"><b>${esc(c.finalidade)} — não é compra de mercadoria.</b>
        Os itens abaixo só repetem os produtos de uma nota anterior; os valores são ${/juros/.test(c.finalidade) ? 'a multa e os juros' : 'o ajuste'}, não o preço pago.
        Por isso esta nota não entra no estoque nem muda o preço dos insumos. Se houver valor a pagar, lance pela Caixa de entrada (contas a pagar).</div>
      <div class="card"><div class="table-wrap"><table class="cc-tab"><thead><tr><th>Item na nota</th><th class="n">Qtd</th><th class="n">Valor</th></tr></thead>
        <tbody>${r.itens.map(it => `<tr class="ign"><td class="cc-desc"><b>${esc(it.descricao)}</b>${it.codigo ? `<small>cód. ${esc(it.codigo)}</small>` : ''}</td>
          <td class="n">${fmtQtd(Number(it.quantidade))} <small>${esc(it.unidade || '')}</small></td><td class="n">${money(it.valor_total)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="ct-rodape cc-rodape"><button class="btn" id="cc-voltar">Voltar</button></div>`;
    box.querySelector('#cc-voltar').onclick = () => voltarOuIr('#/inbox');
    return;
  }

  const linha = it => {
    const st = it.n == null ? 'novo' : it.situacao;
    const [cls, rot] = SITUACAO_ITEM[st] || SITUACAO_ITEM.pendente;
    const editavel = !xml;
    return `<tr data-n="${it.n ?? ''}" class="${it.ignorado ? 'ign' : ''}">
      <td class="cc-desc">${editavel ? `<input data-f="descricao" value="${esc(it.descricao || '')}" placeholder="Descrição do item">`
          : `<b>${esc(it.descricao)}</b>`}
        <small>${it.codigo ? `cód. ${esc(it.codigo)} · ` : ''}${it.ean ? `barras ${esc(it.ean)} · ` : ''}<span class="cc-st ${cls}">${rot}${it.vinculo_por ? ` pelo ${it.vinculo_por}` : ''}</span></small></td>
      <td class="n">${editavel ? `<input data-f="quantidade" inputmode="decimal" class="cc-qtd" value="${it.quantidade != null ? fmtQtd(Number(it.quantidade)) : ''}" placeholder="Qtd">
          <input data-f="unidade" class="cc-un" value="${esc(it.unidade || 'UN')}" maxlength="10">`
          : `${fmtQtd(Number(it.quantidade))} <small>${esc(it.unidade || '')}</small>`}</td>
      <td class="n">${editavel ? `<input data-f="valor_total" class="money cc-val" inputmode="decimal" value="${fmtMoeda(it.valor_total)}" placeholder="0,00">`
          : money(it.valor_total)}</td>
      <td class="cc-ins"><select data-f="insumo_id" ${it.ignorado ? 'disabled' : ''}>${opIns(it.insumo_id)}</select>
        ${it.sugestoes?.length > 1 && !it.insumo_id ? `<small>Sugestões: ${it.sugestoes.map(s => `<button type="button" class="link-btn" data-sug="${s.insumo_id}" data-fat="${s.fator ?? ''}">${esc(s.nome)}</button>`).join(' · ')}</small>` : ''}
        <span class="cc-acoes"><button type="button" class="link-btn cc-novo" data-novo ${it.ignorado ? 'hidden' : ''}>＋ Novo insumo</button>
          <label class="check-l"><input type="checkbox" data-f="ignorar" ${it.ignorado ? 'checked' : ''}> não é insumo</label>
          ${editavel ? '<button type="button" class="link-btn neg" data-remover>remover</button>' : ''}</span></td>
      <td class="cc-fat"><span>1 <span data-un-nota>${esc(it.unidade || 'UN')}</span> =
        <input data-f="fator" inputmode="decimal" value="${it.fator != null ? fmtQtd(Number(it.fator)) : ''}" placeholder="?" ${it.ignorado ? 'disabled' : ''}>
        <span data-un-ins></span></span><span class="cc-preco" data-preco></span></td></tr>`;
  };

  box.innerHTML = `
    <div class="card cc-cab">
      ${xml ? `<div><small>Fornecedor</small><b>${esc(c.emitente_nome || '—')}</b><span class="muted">${c.fornecedor_cadastro ? `cadastro: ${esc(c.fornecedor_cadastro)}` : 'sem cadastro ligado'}</span></div>
        <div><small>Nota</small><b>NF ${esc(c.numero || '—')}${c.serie ? ` · série ${esc(c.serie)}` : ''}</b><span class="muted">emitida ${c.emissao ? dm(c.emissao) + '/' + c.emissao.slice(0, 4) : '—'}</span></div>`
      : `<label>Fornecedor<input id="cc-forn" value="${esc(c.emitente_nome || '')}" placeholder="Nome do fornecedor"></label>
        <label>CNPJ / CPF<input id="cc-cnpj" value="${esc(c.emitente_cnpj || '')}" placeholder="Se tiver"></label>
        <label>Número<input id="cc-num" value="${esc(c.numero || '')}" placeholder="Se tiver"></label>
        <label>Data da compra<input id="cc-data" type="date" value="${c.emissao || ''}"></label>`}
      <div><small>Total da nota</small><b>${total ? money(total) : '—'}</b><span class="muted" id="cc-soma"></span></div>
      <div class="cc-links">${c.documento_id ? `<a class="btn sm" href="/api/inbox/${c.documento_id}/arquivo" target="_blank" rel="noopener">Ver arquivo ↗</a>` : ''}
        <span class="muted small-txt">${c.no_financeiro ? 'Já lançada em contas a pagar.' : 'Ainda não lançada no financeiro.'}</span></div>
    </div>
    ${!xml && !r.itens.length ? `<div class="card cc-vazia">
        <b>Esta nota veio em foto ou PDF.</b> Os itens precisam ser lidos ou digitados.
        <div class="actions" style="justify-content:flex-start;margin-top:8px">
          <button class="btn primary" id="cc-ia" ${r.ia_disponivel ? '' : 'disabled'}>Ler itens com IA</button>
          <button class="btn" id="cc-digitar">Digitar os itens</button></div>
        ${r.ia_disponivel ? '' : '<p class="muted small-txt">A leitura por IA fica disponível quando a chave da Anthropic for cadastrada no servidor.</p>'}
      </div>` : ''}
    <div class="card" id="cc-tab-card" ${!xml && !r.itens.length ? 'hidden' : ''}><div class="table-wrap"><table class="cc-tab">
      <thead><tr><th>Item na nota</th><th class="n">Qtd</th><th class="n">Total</th><th>Insumo no sistema</th><th>Conversão (estoque) → preço</th></tr></thead>
      <tbody id="cc-linhas">${r.itens.map(linha).join('')}</tbody></table></div>
      ${xml ? '' : '<button type="button" class="btn sm" id="cc-add">＋ Adicionar item</button>'}
    </div>
    <div class="ct-rodape cc-rodape">
      <label class="check-l"><input type="checkbox" id="cc-lembrar" checked> Lembrar os vínculos para as próximas notas</label>
      <label class="check-l"><input type="checkbox" id="cc-preco" checked> Atualizar o preço dos insumos (último preço pago)</label>
      <span class="muted small-txt" id="cc-prog"></span><div class="dlg-err" id="cc-err" hidden></div>
      <button class="btn primary" id="cc-salvar">Salvar conciliação</button></div>`;

  const tb = box.querySelector('#cc-linhas');
  const valLinha = tr => {
    const g = f => tr.querySelector(`[data-f="${f}"]`);
    return { qtd: xml ? Number(r.itens.find(i => String(i.n) === tr.dataset.n)?.quantidade) : lerQtd(g('quantidade').value),
             total: xml ? Number(r.itens.find(i => String(i.n) === tr.dataset.n)?.valor_total) : lerMoeda(g('valor_total').value),
             ins: porId[g('insumo_id').value], fator: lerQtd(g('fator').value), ign: g('ignorar').checked,
             unNota: xml ? r.itens.find(i => String(i.n) === tr.dataset.n)?.unidade : g('unidade').value };
  };
  const recalc = () => {
    let prontos = 0, soma = 0;
    const linhas = [...tb.querySelectorAll('tr')];
    linhas.forEach(tr => {
      const x = valLinha(tr);
      soma += x.total || 0;
      tr.querySelector('[data-un-nota]').textContent = (x.unNota || 'UN').toUpperCase();
      tr.querySelector('[data-un-ins]').textContent = x.ins ? x.ins.unidade : '';
      tr.classList.toggle('ign', x.ign);
      const cel = tr.querySelector('[data-preco]');
      if (x.ign) { cel.innerHTML = '<span class="muted">—</span>'; prontos++; return; }
      if (!x.ins || !(x.fator > 0) || !(x.qtd > 0)) { cel.innerHTML = '<span class="muted">—</span>'; return; }
      prontos++;
      const preco = x.total / (x.qtd * x.fator), atual = Number(x.ins.custo_unitario);
      const varia = atual > 0 ? (preco - atual) / atual * 100 : null;
      // 2ª conversão: unidade de compra (estoque) → unidade de saída (ficha técnica), ex.: 1 un = 0,236 l
      const s = x.ins.saida_tipo, base = Number(x.ins.saida_base), rende = Number(x.ins.saida_rende);
      const saida = s && s !== 'compra' && base > 0 && rende > 0
        ? `<small class="cc-saida">na ficha: 1 ${esc(x.unNota || 'UN')} = ${fmtQtd(Math.round(x.fator * rende / base * 10000) / 10000)} ${ROT_UN_SAIDA[s] || s}
            → <b>${moneyFino(preco * base / rende)}/${ROT_UN_SAIDA[s] || s}</b></small>` : '';
      cel.innerHTML = `<b>${money(preco)}</b>/${x.ins.unidade}${varia != null && Math.abs(varia) >= 0.5
        ? `<small class="${varia > 0 ? 'neg' : 'ok-txt'}">${varia > 0 ? '▲' : '▼'} ${num1.format(Math.abs(varia))}% (era ${money(atual)})</small>` : atual > 0 ? '<small class="muted">igual ao atual</small>' : '<small class="muted">sem preço anterior</small>'}${saida}`;
    });
    box.querySelector('#cc-prog').textContent = `${prontos} de ${linhas.length} itens prontos`;
    const dif = total ? Math.round((soma - total) * 100) / 100 : 0;
    box.querySelector('#cc-soma').innerHTML = linhas.length ? `soma dos itens ${money(soma)}${total && Math.abs(dif) > 0.05 ? ` · <span class="muted">diferença ${money(dif)} (frete/desconto/impostos)</span>` : ''}` : '';
  };
  // ao escolher o insumo, sugere a conversão pela descrição e pelas unidades
  const sugerirFator = tr => {
    const x = valLinha(tr);
    if (!x.ins || tr.querySelector('[data-f="fator"]').value) return;
    const desc = xml ? r.itens.find(i => String(i.n) === tr.dataset.n)?.descricao : tr.querySelector('[data-f="descricao"]').value;
    const conv = fatorDaDescricao(desc, x.unNota, x.ins.unidade);
    if (conv != null) tr.querySelector('[data-f="fator"]').value = fmtQtd(conv);
  };
  box.addEventListener('input', recalc);
  box.addEventListener('change', e => {
    const tr = e.target.closest('tr[data-n]');
    if (tr && e.target.dataset.f === 'insumo_id') { tr.querySelector('[data-f="fator"]').value = ''; sugerirFator(tr); }
    if (tr && e.target.dataset.f === 'ignorar') {
      ['insumo_id', 'fator'].forEach(f => { tr.querySelector(`[data-f="${f}"]`).disabled = e.target.checked; });
      tr.querySelector('[data-novo]').hidden = e.target.checked;
    }
    recalc();
  });
  box.addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-n]');
    const sug = e.target.closest('[data-sug]');
    if (sug) { tr.querySelector('[data-f="insumo_id"]').value = sug.dataset.sug; tr.querySelector('[data-f="fator"]').value = sug.dataset.fat ? fmtQtd(Number(sug.dataset.fat)) : ''; sugerirFator(tr); recalc(); }
    if (e.target.closest('[data-remover]')) { tr.dataset.remover = '1'; tr.hidden = true; recalc(); }
    if (e.target.closest('[data-novo]')) novoInsumo(tr);
  });
  const addLinha = () => { tb.insertAdjacentHTML('beforeend', linha({ n: null, descricao: '', unidade: 'UN', quantidade: null, valor_total: null })); tb.lastElementChild.querySelector('[data-f="descricao"]').focus(); recalc(); };
  box.querySelector('#cc-add')?.addEventListener('click', addLinha);
  box.querySelector('#cc-digitar')?.addEventListener('click', () => { box.querySelector('.cc-vazia').hidden = true; box.querySelector('#cc-tab-card').hidden = false; addLinha(); });
  box.querySelector('#cc-ia')?.addEventListener('click', async ev => {
    const b = ev.target; b.disabled = true; b.textContent = 'Lendo a nota…';
    try { const x = await send('POST', `compras/${cid}/ler-itens`); FLASH = `A IA leu ${x.itens} itens. Confira e ligue cada um a um insumo.`; render(); }
    catch (ex) { b.disabled = false; b.textContent = 'Ler itens com IA'; const err = box.querySelector('#cc-err'); err.hidden = false; err.textContent = ex.message; }
  });

  // cadastra um insumo novo sem sair da conciliação, já com nome e unidade puxados da nota
  // cadastra um insumo novo sem sair da conciliação: nome e unidade de compra vêm da nota (para confirmar),
  // e já define a unidade de saída (como é usado na ficha), com o rendimento sugerido pela descrição (ex.: 980ML)
  async function novoInsumo(tr) {
    const x = valLinha(tr);
    const cats = await api('cad/categorias-itens?grupo=insumo');
    const desc = (xml ? r.itens.find(i => String(i.n) === tr.dataset.n)?.descricao : tr.querySelector('[data-f="descricao"]').value) || '';
    const nome = desc.toLowerCase().replace(/\b\d+([.,]\d+)?\s*(kg|g|gr|l|lt|ml|un|und)\b/gi, '').replace(/\s+/g, ' ').trim()
      .replace(/(^|\s)\S/g, s => s.toUpperCase()).slice(0, 120);
    const un = UN_DA_NOTA[(x.unNota || '').toUpperCase()] || 'un';
    const opt = (lista, sel) => lista.map(([v, rot]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(rot)}</option>`).join('');
    const dlg = document.getElementById('dlg');
    dlg.className = 'dlg largo';
    dlg.innerHTML = `<form method="dialog" class="dlg-body cad-form" novalidate>
      <h3>Novo insumo</h3>
      <p class="sub">Da nota: “${esc(desc)}”.</p>
      <div class="cad-grid">
        <label class="span2">Nome do insumo *<input name="nome" required maxlength="120" value="${esc(nome)}"></label>
        <label>Categoria<select name="categoria_id"><option value="">— Sem categoria —</option>${opt(cats.filter(k => k.ativo).map(k => [k.id, k.nome]), '')}</select></label>
        <label>Unidade de compra <small>(veio da nota: ${esc(x.unNota || '—')})</small><select name="unidade">${opt(UNIDADES, un)}</select></label>
        <label class="span2">Unidade de saída <small>como o insumo é medido na ficha técnica e no estoque</small>
          <select name="saida_tipo">${opt(Object.entries(SAIDA), 'compra')}</select></label>
        <div class="span2 ce-saida" data-saida hidden>
          <label><span data-rot-base></span><input name="saida_base" inputmode="decimal" value="1"></label>
          <label><span data-rot-rende></span><input name="saida_rende" inputmode="decimal" placeholder="0"></label>
          <p class="ce-saida-res" data-res></p>
        </div>
      </div>
      <div class="dlg-err" hidden></div>
      <div class="actions"><button value="cancel" class="btn" formnovalidate>Cancelar</button><button value="ok" class="btn primary">Salvar</button></div>
    </form>`;
    const f = dlg.querySelector('form'), err = dlg.querySelector('.dlg-err');
    let rendeManual = false;   // o rendimento é sugerido até a pessoa digitar o dela
    const atualizar = () => {
      const compra = f.unidade.value, saida = f.saida_tipo.value, ehOutra = saida !== 'compra';
      dlg.querySelector('[data-saida]').hidden = !ehOutra;
      if (!ehOutra) return;
      const unSaida = ROT_UN_SAIDA[saida] || saida;
      dlg.querySelector('[data-rot-base]').textContent = `Quantidade comprada (${compra})`;
      dlg.querySelector('[data-rot-rende]').textContent = RENDE_SAIDA[saida] || 'Quanto rende';
      if (!rendeManual) {   // ex.: "RUM 980ML" comprado em unidade → 980 ml ou 0,98 l
        const sug = ['limpo', 'porcoes'].includes(saida) ? null : fatorDaDescricao(desc, compra, saida);
        f.saida_rende.value = sug != null ? fmtQtd(sug) : '';
        f.saida_base.value = '1';
      }
      const base = lerQtd(f.saida_base.value), rende = lerQtd(f.saida_rende.value);
      // preço desta nota na unidade de compra → custo por unidade de saída
      const fatNota = fatorDaDescricao(desc, x.unNota, compra) || 1;
      const precoCompra = x.qtd > 0 ? x.total / (x.qtd * fatNota) : null;
      dlg.querySelector('[data-res]').innerHTML = base > 0 && rende > 0
        ? `${fmtQtd(base)} ${compra} rende ${fmtQtd(rende)} ${unSaida}${precoCompra ? ` — com o preço desta nota (${money(precoCompra)}/${compra}): <b>${moneyFino(precoCompra * base / rende)} por ${unSaida}</b>` : ''}.`
        : 'Informe quanto foi comprado e quanto rende.';
    };
    f.addEventListener('input', ev => { if (ev.target.name === 'saida_rende') rendeManual = true; atualizar(); });
    f.addEventListener('change', ev => { if (ev.target.name === 'saida_tipo' || ev.target.name === 'unidade') rendeManual = false; atualizar(); });
    f.addEventListener('submit', async ev => {
      if (ev.submitter?.value !== 'ok') return;
      ev.preventDefault(); err.hidden = true;
      const saida = f.saida_tipo.value, base = lerQtd(f.saida_base.value), rende = lerQtd(f.saida_rende.value);
      if (!f.nome.value.trim()) { err.hidden = false; err.textContent = 'Informe o nome.'; return; }
      if (saida !== 'compra' && !(base > 0 && rende > 0)) { err.hidden = false; err.textContent = 'Informe quanto foi comprado e quanto rende na unidade de saída.'; return; }
      try {
        const novo = await send('POST', 'cad/insumos', { tipo: 'insumo', ativo: true, nome: f.nome.value.trim(), categoria_id: f.categoria_id.value || null,
          unidade: f.unidade.value, saida_tipo: saida, saida_base: saida === 'compra' ? null : base, saida_rende: saida === 'compra' ? null : rende });
        dlg.close();
        const ins = { id: novo.id, nome: novo.nome, unidade: novo.unidade, custo_unitario: null, saida_tipo: novo.saida_tipo,
                      saida_base: novo.saida_base, saida_rende: novo.saida_rende, categoria: cats.find(k => k.id === novo.categoria_id)?.nome || 'Sem categoria' };
        insumos.push(ins); porId[ins.id] = ins; (grupos[ins.categoria] ||= []).push(ins);
        box.querySelectorAll('[data-f="insumo_id"]').forEach(s => { const v = s.value; s.innerHTML = opIns(v); });
        tr.querySelector('[data-f="insumo_id"]').value = ins.id;
        tr.querySelector('[data-f="fator"]').value = '';
        sugerirFator(tr); recalc();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    });
    dlg.showModal();
    atualizar();
  }

  box.querySelector('#cc-salvar').onclick = async () => {
    const err = box.querySelector('#cc-err'); err.hidden = true;
    const itens = [];
    for (const tr of tb.querySelectorAll('tr')) {
      const n = tr.dataset.n ? Number(tr.dataset.n) : null;
      if (tr.dataset.remover) { if (n != null) itens.push({ n, remover: true }); continue; }
      const x = valLinha(tr), item = { n, ignorar: x.ign, insumo_id: x.ign ? null : (x.ins?.id || null), fator: x.ign || !x.ins ? null : (x.fator > 0 ? x.fator : null) };
      if (!xml) Object.assign(item, { descricao: tr.querySelector('[data-f="descricao"]').value.trim() || null, quantidade: x.qtd > 0 ? x.qtd : null,
                                      unidade: (x.unNota || 'UN').toUpperCase(), valor_total: isNaN(x.total) ? null : x.total });
      if (n == null && !item.descricao) continue;
      if (item.insumo_id && !item.fator) { err.hidden = false; err.textContent = `Informe a conversão de “${(item.descricao || r.itens.find(i => i.n === n)?.descricao || '').slice(0, 40)}”.`; return; }
      itens.push(item);
    }
    const corpo = { itens, lembrar: box.querySelector('#cc-lembrar').checked, atualizar_preco: box.querySelector('#cc-preco').checked };
    if (!xml) Object.assign(corpo, { emitente_nome: box.querySelector('#cc-forn').value.trim() || null, emitente_cnpj: box.querySelector('#cc-cnpj').value.trim() || null,
                                     numero: box.querySelector('#cc-num').value.trim() || null, emissao: box.querySelector('#cc-data').value || null });
    const btn = box.querySelector('#cc-salvar'); btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      const s = await send('POST', `compras/${cid}/conciliar`, corpo);
      FLASH = s.completa ? `Nota conciliada: ${s.conciliados} itens. Estoque e preços atualizados.`
        : `Salvo: ${s.conciliados} de ${s.itens} itens conciliados. Os que faltam ficam pendentes.`;
      atualizarBadgeInbox(); atualizarBadgeAfazeres();
      voltarOuIr('#/inbox');   // volta para onde estava (Caixa de entrada, Lista de tarefas...)
    } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Salvar conciliação'; }
  };
  recalc();
}
