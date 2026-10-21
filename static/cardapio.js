// Cardápio: engenharia de cardápio (popularidade × margem), precificação e vendas por produto.
// O CMV de cada produto vem da ficha técnica (fichas.py); as contas espelham cardapio.py.

const CLASSE = {
  estrela: { rot: 'Estrela', cor: '#2F6FB0', dica: 'Vende muito e dá boa margem. Mantenha a receita, o preço e o destaque no cardápio.' },
  burro: { rot: 'Burro de carga', cor: '#D08A1E', dica: 'Vende muito, margem baixa. Revise a ficha (porção, insumos) ou suba o preço aos poucos.' },
  quebra: { rot: 'Quebra-cabeça', cor: '#7A5BC2', dica: 'Boa margem, vende pouco. Dê destaque: posição no cardápio, foto, sugestão da equipe.' },
  cao: { rot: 'Cão', cor: '#C2577A', dica: 'Vende pouco e dá pouca margem. Reformule ou tire do cardápio.' },
  sem_vendas: { rot: 'Sem vendas', cor: '#C5D2DF', dica: 'Nenhuma venda informada no período.' },
};
const pctFmt = (v, d = 1) => v == null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
const mesAnterior = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const nomeMes = m => { const [a, n] = m.split('-'); return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][n - 1]}/${a.slice(2)}`; };
const normNome = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const lerNum = v => { const s = String(v ?? '').trim(); return s ? Number(s.replace(/\./g, s.includes(',') ? '' : '.').replace(',', '.')) : null; };
const badgeClasse = c => `<span class="cls-badge" style="--c:${CLASSE[c].cor}">${CLASSE[c].rot}</span>`;

// ---------------------------------------------------------------- engenharia
async function abaEngenharia(box, p) {
  const ate = p.ate || p.de || mesAnterior(), de = p.de || ate, por = p.por === 'todos' ? 'todos' : 'categoria';
  const e = await api(`cardapio/engenharia?de=${de}&ate=${ate}&por=${por}`);
  const temVendas = e.grupos.some(g => g.vendidos > 0);
  const gSel = e.grupos.find(g => g.grupo === p.g && g.vendidos > 0) || e.grupos.find(g => g.vendidos > 0) || e.grupos[0];
  const link = mud => `#/cardapio?${new URLSearchParams({ aba: 'engenharia', de, ate, por, ...(gSel ? { g: gSel.grupo } : {}), ...mud })}`;
  const conta = c => gSel ? gSel.produtos.filter(x => x.classe === c).length : 0;
  box.innerHTML = `
    <div class="card filters"><div class="filter-row">
      <label>De<input type="month" id="e-de" value="${de}"></label>
      <label>Até<input type="month" id="e-ate" value="${ate}"></label>
      <div class="chips" style="align-self:end"><a class="chip ${por === 'categoria' ? 'on' : ''}" href="${link({ por: 'categoria' })}">Por categoria</a>
        <a class="chip ${por === 'todos' ? 'on' : ''}" href="${link({ por: 'todos', g: '' })}">Cardápio todo</a></div>
      ${e.meses_com_vendas.length ? `<span class="muted small-txt" style="align-self:end;margin:0 0 6px">Meses com vendas: ${e.meses_com_vendas.map(nomeMes).join(', ')}</span>` : ''}
    </div></div>
    ${!temVendas ? `<div class="card empty">Nenhuma venda por produto informada ${de === ate ? `em ${nomeMes(de)}` : `entre ${nomeMes(de)} e ${nomeMes(ate)}`}.<br>
      A engenharia cruza a <b>margem</b> de cada prato (da ficha técnica) com a <b>quantidade vendida</b>.
      <div style="margin-top:10px"><a class="btn primary" href="#/cardapio?aba=vendas&mes=${ate}">Informar vendas por produto</a></div></div>` : `
    ${por === 'categoria' ? `<div class="chips eng-grupos">${e.grupos.filter(g => g.vendidos > 0).map(g =>
      `<a class="chip ${g === gSel ? 'on' : ''}" href="${link({ g: g.grupo })}">${esc(g.grupo)}</a>`).join('')}</div>` : ''}
    <div class="grid g4 eng-kpis">
      ${kpi('Itens vendidos', num1.format(gSel.vendidos).replace(/,0$/, ''), `${gSel.itens} produto(s) com venda`)}
      ${kpi('Faturamento teórico', money(gSel.faturamento), 'quantidade × preço de salão')}
      ${kpi('Margem de contribuição', money(gSel.mc_total), `média de ${money(gSel.mc_media)} por item`)}
      ${kpi('Corte de popularidade', pctFmt(gSel.corte_pop_pct), 'participação mínima para ser "popular"')}
    </div>
    <div class="eng-grid">
      <div class="card"><div class="graf-head"><div><h3>Matriz do cardápio</h3><div class="sub">Popularidade (participação nas vendas) × margem por item. Linhas = cortes.</div></div></div>
        <div class="eng-chart"><canvas id="eng-chart"></canvas></div>
        <div class="eng-leg">${['estrela', 'burro', 'quebra', 'cao'].map(c => `<span><i style="background:${CLASSE[c].cor}"></i>${CLASSE[c].rot} · ${conta(c)}</span>`).join('')}</div></div>
      <div class="card eng-classes">${['estrela', 'burro', 'quebra', 'cao'].map(c => `<div class="eng-classe">
        ${badgeClasse(c)} <b>${conta(c)}</b><p>${CLASSE[c].dica}</p></div>`).join('')}</div>
    </div>
    <div class="card"><h3>${esc(gSel.grupo)}</h3>
      ${table([
        { t: 'Produto', f: x => `<a href="#/cadastros?aba=produtos&item=produto:${x.id}">${esc(x.nome)}</a>` },
        { t: 'Vendidos', n: 1, f: x => x.qtd ? num1.format(x.qtd).replace(/,0$/, '') : '—' },
        { t: 'Mix', n: 1, f: x => x.qtd ? pctFmt(x.mix_pct) : '—' },
        { t: 'Preço', n: 1, f: x => money(x.preco_venda) }, { t: 'CMV', n: 1, f: x => money(x.cmv) },
        { t: 'CMV %', n: 1, f: x => `<span class="${corCmv(x.cmv_pct)}">${pctFmt(x.cmv_pct)}</span>` },
        { t: 'Margem/item', n: 1, f: x => money(x.mc) }, { t: 'Margem total', n: 1, f: x => x.qtd ? money(x.mc * x.qtd) : '—' },
        { t: 'Lucro/item', n: 1, f: x => `<span class="${x.lucro < 0 ? 'neg' : ''}">${money(x.lucro)}</span>` },
        { t: 'Classe', f: x => badgeClasse(x.classe) },
      ], [...gSel.produtos].sort((a, b) => b.qtd - a.qtd || b.mc - a.mc))}
      <p class="muted small-txt">Lucro/item = preço − CMV − ${pctFmt(gSel.produtos[0]?.cvt_pct)} de custos sobre a venda (cartão, imposto, custo fixo — ver Precificação).</p></div>`}
    ${e.fora.length ? `<div class="card"><h3>Fora da análise</h3><div class="sub">Precisam de ficha técnica e preço de venda.</div>
      <div class="fora-lista">${e.fora.map(x => `<a href="#/cadastros?aba=produtos&item=produto:${x.id}">${esc(x.nome)} <small>${x.motivo}</small></a>`).join('')}</div></div>` : ''}`;
  const ir = () => { location.hash = link({ de: box.querySelector('#e-de').value || de, ate: box.querySelector('#e-ate').value || ate }); };
  box.querySelector('#e-de').onchange = ir; box.querySelector('#e-ate').onchange = ir;
  if (temVendas) graficoMatriz(box.querySelector('#eng-chart'), gSel);
}

function graficoMatriz(el, g) {
  const pts = g.produtos.filter(x => x.qtd > 0);
  const cortes = {   // linhas de corte (popularidade e margem média)
    id: 'cortes',
    afterDraw(c) {
      const { ctx, chartArea: a, scales: { x, y } } = c;
      ctx.save(); ctx.strokeStyle = '#9FB3C8'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      const px = x.getPixelForValue(g.corte_pop_pct), py = y.getPixelForValue(g.mc_media);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      ctx.restore();
    },
  };
  charts.push(new Chart(el, {
    type: 'scatter',
    data: { datasets: ['estrela', 'burro', 'quebra', 'cao'].map(c => ({
      label: CLASSE[c].rot, backgroundColor: CLASSE[c].cor, borderColor: '#fff', borderWidth: 2, pointRadius: 6, pointHoverRadius: 8,
      data: pts.filter(x => x.classe === c).map(x => ({ x: x.mix_pct, y: x.mc, nome: x.nome, qtd: x.qtd })),
    })) },
    options: {
      maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: i => `${i.raw.nome}: ${pctFmt(i.raw.x)} das vendas (${num1.format(i.raw.qtd).replace(/,0$/, '')}) · margem ${money(i.raw.y)}`,
      } } },
      scales: {
        x: { title: { display: true, text: 'Participação nas vendas (%)', color: '#7F94AA', font: { size: 11 } }, beginAtZero: true,
             grid: { color: '#EEF3F8' }, ticks: { color: '#7F94AA', callback: v => `${v}%` } },
        y: { title: { display: true, text: 'Margem por item (R$)', color: '#7F94AA', font: { size: 11 } }, grace: '15%',
             grid: { color: '#EEF3F8' }, ticks: { color: '#7F94AA', callback: v => money(v) } },
      },
    },
    plugins: [cortes],
  }));
}

// ---------------------------------------------------------------- precificação
async function abaPrecificacao(box, p) {
  const r = await api('cardapio/precificacao');
  const par = r.parametros, canal = p.canal === 'app' ? 'app' : 'salao', app = canal === 'app';
  const cats = [...new Set(r.produtos.map(x => x.categoria || 'Sem categoria'))];
  const cat = cats.includes(p.cat) ? p.cat : '';
  const lista = r.produtos.filter(x => !cat || (x.categoria || 'Sem categoria') === cat);
  const link = mud => `#/cardapio?${new URLSearchParams({ aba: 'precificacao', canal, cat, ...mud })}`;
  const campoPar = (k, rot) => `<label>${rot}<span class="pct-in"><input data-par="${k}" inputmode="decimal" value="${fmtQtd(par[k])}">%</span></label>`;
  box.innerHTML = `
    <div class="card prec-par">
      <div><h3>Custos sobre a venda</h3><div class="sub">Percentuais aplicados a todo o cardápio. Custo fixo = despesas fixas do mês ÷ faturamento.</div></div>
      <div class="filter-row">
        ${campoPar('cartao_pct', 'Máquina de cartão')}${campoPar('imposto_pct', 'Imposto')}${campoPar('custo_fixo_pct', 'Custo fixo')}
        ${campoPar('lucro_desejado_pct', 'Lucro desejado (padrão)')}${campoPar('taxa_app_pct', 'Taxa do app')}
        <div class="prec-cvt"><small>Custos sobre a venda</small><b id="cvt"></b></div>
        <button class="btn" id="salvar-par" style="align-self:end">Salvar percentuais</button>
      </div>
      <p class="muted small-txt">Preço sugerido = CMV ÷ (100% − custos sobre a venda − lucro desejado). No app, o sugerido ainda é dividido por (100% − taxa do app).</p>
    </div>
    <div class="card filters"><div class="filter-row">
      <div class="chips"><a class="chip ${!app ? 'on' : ''}" href="${link({ canal: 'salao' })}">Salão</a><a class="chip ${app ? 'on' : ''}" href="${link({ canal: 'app' })}">App de delivery</a></div>
      <label>Categoria<select id="p-cat"><option value="">Todas</option>${cats.map(c => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    </div></div>
    <div class="card">
      <div class="table-wrap"><table class="prec-tab"><thead><tr>
        <th>Produto</th><th class="n">CMV</th><th class="n">Preço ${app ? 'no app' : 'atual'}</th><th class="n">CMV %</th><th class="n">Lucro hoje</th>
        <th class="n">Lucro alvo</th><th class="n">Preço sugerido</th><th class="n">Novo preço</th><th class="n">Lucro no novo</th></tr></thead>
        <tbody>${lista.map(x => `<tr data-id="${x.id}">
          <td><a href="#/cadastros?aba=produtos&item=produto:${x.id}">${esc(x.nome)}</a>${x.cmv == null ? ' <small class="muted">sem ficha</small>' : ''}</td>
          <td class="n">${x.cmv != null ? money(x.cmv) : '—'}</td>
          <td class="n">${(app ? x.preco_app : x.preco_venda) != null ? money(app ? x.preco_app : x.preco_venda) : '—'}</td>
          <td class="n" data-c="cmvp"></td><td class="n" data-c="lucro"></td>
          <td class="n"><span class="pct-in"><input data-lucro inputmode="decimal" value="${x.lucro_desejado_pct != null ? fmtQtd(x.lucro_desejado_pct) : ''}" placeholder="${fmtQtd(par.lucro_desejado_pct)}">%</span></td>
          <td class="n"><button type="button" class="link-btn" data-c="sug" data-usar title="Usar como novo preço (arredonda para ,90)"></button></td>
          <td class="n"><input class="money" data-novo inputmode="decimal" placeholder="—"></td><td class="n" data-c="novo"></td></tr>`).join('')}</tbody></table></div>
      <div class="actions" style="justify-content:space-between;margin-top:10px">
        <span class="muted small-txt">Clique no preço sugerido para usá-lo (arredondado para ,90). Só os produtos alterados são gravados.</span>
        <span class="muted small-txt" id="sujo-p"></span>
        <button class="btn primary" id="salvar-precos">Salvar preços</button></div>
      <div class="dlg-err" id="err-p" hidden></div>
    </div>`;
  const porId = Object.fromEntries(r.produtos.map(x => [x.id, x]));
  const parAtual = () => Object.fromEntries([...box.querySelectorAll('[data-par]')].map(i => [i.dataset.par, lerNum(i.value) ?? 0]));
  const lucroTxt = (v, preco) => v == null ? '—' : `<span class="${v < 0 ? 'neg' : ''}">${money(v)} <small>${pctFmt(v / preco * 100)}</small></span>`;
  const calc = () => {
    const pr = parAtual(), cvt = (pr.cartao_pct + pr.imposto_pct + pr.custo_fixo_pct) / 100, taxa = app ? pr.taxa_app_pct / 100 : 0;
    box.querySelector('#cvt').textContent = pctFmt(cvt * 100) + (app ? ` + ${pctFmt(taxa * 100)} app` : '');
    box.querySelectorAll('tr[data-id]').forEach(tr => {
      const x = porId[tr.dataset.id], preco = app ? x.preco_app : x.preco_venda;
      const alvo = (lerNum(tr.querySelector('[data-lucro]').value) ?? pr.lucro_desejado_pct) / 100;
      const novo = lerMoeda(tr.querySelector('[data-novo]').value);
      const c = k => tr.querySelector(`[data-c="${k}"]`);
      if (x.cmv == null) { ['cmvp', 'lucro', 'sug', 'novo'].forEach(k => { c(k).textContent = '—'; }); return; }
      const lucro = v => v - x.cmv - v * (cvt + taxa);
      const cmvp = preco ? x.cmv / preco * 100 : null;
      c('cmvp').innerHTML = `<span class="${corCmv(cmvp)}">${pctFmt(cmvp)}</span>`;
      c('lucro').innerHTML = preco ? lucroTxt(lucro(preco), preco) : '—';
      const den = 1 - cvt - alvo;
      const sug = den > 0 ? x.cmv / den / (1 - taxa) : null;
      c('sug').textContent = sug ? money(sug) : 'impossível';
      c('sug').dataset.valor = sug || '';
      c('sug').title = sug ? 'Usar como novo preço (arredonda para ,90)' : 'Custos + lucro desejado passam de 100% da venda';
      c('novo').innerHTML = novo > 0 ? lucroTxt(lucro(novo), novo) : '';
    });
  };
  const sujar = () => { box.querySelector('#sujo-p').textContent = 'Alterações não salvas'; };
  box.addEventListener('input', e => { if (e.target.matches('[data-lucro],[data-novo]')) sujar(); calc(); });
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-usar]');
    if (!b || !b.dataset.valor) return;
    const v = Math.ceil(Number(b.dataset.valor) - 0.9) + 0.9;   // arredonda para cima até ,90
    b.closest('tr').querySelector('[data-novo]').value = fmtMoeda(v); sujar(); calc();
  });
  box.querySelector('#p-cat').onchange = e => { location.hash = link({ cat: e.target.value }); };
  box.querySelector('#salvar-par').onclick = async ev => {
    try { await send('PUT', 'cardapio/parametros', parAtual()); FLASH = 'Percentuais salvos.'; render(); }
    catch (ex) { ev.target.insertAdjacentHTML('afterend', `<span class="dlg-err">${esc(ex.message)}</span>`); }
  };
  box.querySelector('#salvar-precos').onclick = async () => {
    const err = box.querySelector('#err-p'); err.hidden = true;
    const itens = [...box.querySelectorAll('tr[data-id]')].flatMap(tr => {
      const x = porId[tr.dataset.id], novo = lerMoeda(tr.querySelector('[data-novo]').value);
      const lucro = lerNum(tr.querySelector('[data-lucro]').value);
      const mudouPreco = novo > 0 && novo !== (app ? x.preco_app : x.preco_venda);
      if (!mudouPreco && lucro === x.lucro_desejado_pct) return [];
      return [{ produto_id: x.id, preco_venda: !app && mudouPreco ? novo : x.preco_venda,
                preco_app: app && mudouPreco ? novo : x.preco_app, lucro_desejado_pct: lucro }];
    });
    if (!itens.length) { err.hidden = false; err.textContent = 'Nada mudou.'; return; }
    try { const s = await send('PUT', 'cardapio/precos', { itens }); FLASH = `${s.gravados} produto(s) atualizado(s).`; render(); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; }
  };
  calc();
}

// ---------------------------------------------------------------- vendas por produto
async function abaVendasProduto(box, p) {
  const mes = /^\d{4}-\d{2}$/.test(p.mes || '') ? p.mes : mesAnterior();
  const r = await api(`cardapio/vendas?mes=${mes}`);
  const porCat = {};
  r.produtos.forEach(x => (porCat[x.categoria || 'Sem categoria'] ||= []).push(x));
  const total = r.produtos.reduce((s, x) => s + Number(x.quantidade || 0), 0);
  box.innerHTML = `
    <div class="card filters"><div class="filter-row">
      <label>Mês<input type="month" id="v-mes" value="${mes}"></label>
      ${r.meses.length ? `<div class="chips" style="align-self:end">${r.meses.slice(0, 8).map(m =>
        `<a class="chip ${m.mes === mes ? 'on' : ''}" href="#/cardapio?aba=vendas&mes=${m.mes}">${nomeMes(m.mes)}</a>`).join('')}</div>` : ''}
      <div class="leitor-acoes" style="margin-left:auto;align-self:end"><button class="btn primary" id="importar">⇪ Importar relatório</button>
        <button class="btn" id="colar">Colar do relatório</button></div>
    </div></div>
    <div class="card">
      <div class="graf-head"><div><h3>Quantidade vendida em ${nomeMes(mes)}</h3>
        <div class="sub">Salão + delivery somados. É o que mede a popularidade na engenharia de cardápio.</div></div>
        <div class="muted small-txt" style="margin:0">Total: <b id="v-total">${num1.format(total).replace(/,0$/, '')}</b> itens</div></div>
      <div class="vendas-cols">${Object.entries(porCat).map(([c, ps]) => `<div class="vendas-cat"><div class="fl-cat">${esc(c)}</div>
        ${ps.map(x => `<label class="vendas-lin"><span>${esc(x.nome)}</span>
          <input data-pid="${x.id}" data-nome="${esc(x.nome)}" data-cod="${esc(x.codigo_pdv || '')}" inputmode="decimal" value="${x.quantidade != null ? fmtQtd(Number(x.quantidade)) : ''}" placeholder="—"></label>`).join('')}</div>`).join('')}</div>
      <div class="actions" style="justify-content:flex-end;gap:12px;margin-top:12px">
        <span class="muted small-txt" id="sujo-v"></span><button class="btn primary" id="salvar-v">Salvar vendas de ${nomeMes(mes)}</button></div>
      <div class="dlg-err" id="err-v" hidden></div>
    </div>`;
  const ins = [...box.querySelectorAll('[data-pid]')];
  if (VENDAS_PEND && (!VENDAS_PEND.mes || VENDAS_PEND.mes === mes)) {   // voltando da revisão com produto novo: reaplica o que foi importado (ainda não salvo)
    ins.forEach(i => { if (VENDAS_PEND.valores[i.dataset.pid] != null) i.value = VENDAS_PEND.valores[i.dataset.pid]; });
    setTimeout(() => { box.querySelector('#sujo-v').textContent = 'Alterações não salvas'; box.dispatchEvent(new Event('input')); });
  }
  const pendDoc = VENDAS_PEND?.doc || null;
  VENDAS_PEND = null;
  const somar = () => { box.querySelector('#v-total').textContent = num1.format(ins.reduce((s, i) => s + (lerNum(i.value) || 0), 0)).replace(/,0$/, ''); };
  box.addEventListener('input', () => { box.querySelector('#sujo-v').textContent = 'Alterações não salvas'; somar(); });
  box.querySelector('#v-mes').onchange = e => { if (e.target.value) location.hash = `#/cardapio?aba=vendas&mes=${e.target.value}`; };
  let docImportado = pendDoc;   // relatório da caixa de entrada: vira "processado" ao salvar
  const marcou = () => { box.querySelector('#sujo-v').textContent = 'Alterações não salvas'; somar(); };
  box.querySelector('#colar').onclick = () => colarVendas(ins, marcou);
  const aoImportar = did => { docImportado = did || docImportado; marcou(); };
  box.querySelector('#importar').onclick = () => importarVendas(ins, aoImportar, mes);
  if (VENDAS_IMPORT) { const r0 = VENDAS_IMPORT; VENDAS_IMPORT = null; importarVendas(ins, aoImportar, mes, r0); }
  box.querySelector('#salvar-v').onclick = async () => {
    const err = box.querySelector('#err-v'); err.hidden = true;
    const itens = ins.map(i => ({ produto_id: i.dataset.pid, quantidade: lerNum(i.value) }));
    if (itens.some(i => i.quantidade != null && !(i.quantidade >= 0))) { err.hidden = false; err.textContent = 'Há quantidades inválidas.'; return; }
    try {
      await send('PUT', 'cardapio/vendas', { mes, itens });
      if (docImportado) { try { await send('POST', `inbox/${docImportado}/status`, { status: 'processado' }); atualizarBadgeInbox(); } catch (_) { /* segue */ } }
      FLASH = `Vendas de ${nomeMes(mes)} salvas.${docImportado ? ' O relatório saiu da caixa de entrada.' : ''}`; render();
    }
    catch (ex) { err.hidden = false; err.textContent = ex.message; }
  };
}

// Importa o relatório de vendas (arquivo do computador/celular ou da caixa de entrada): escolhe as colunas,
// soma os produtos repetidos e preenche pelo nome do cadastro. Servidor: cardapio.py (/vendas/ler).
let VENDAS_IMPORT = null;   // relatório já lido, reaberto depois de trocar para o mês do período dele
async function importarVendas(ins, depois, mes, inicial) {
  const d = document.createElement('dialog');
  d.className = 'dlg dlg-largo';
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  const [docs, apelidos] = await Promise.all([api('cardapio/vendas/documentos').catch(() => []), api('cardapio/vendas/apelidos').catch(() => [])]);
  const porPid = Object.fromEntries(ins.map(i => [i.dataset.pid, i]));
  const apel = Object.fromEntries(apelidos.map(a => [a.nome_norm, a]));
  const passo1 = () => {
    d.innerHTML = `<div class="dlg-body"><h3>Importar relatório de vendas</h3>
      <p class="sub">Relatório de produtos vendidos do PDV (Sischef), Anota Aí, Aiqfome ou uma planilha sua — em Excel (.xlsx/.xls), CSV ou PDF.</p>
      <label class="drop" id="iv-drop"><input type="file" hidden accept=".xlsx,.xls,.csv,.txt,.pdf">
        <span class="drop-ico">⇪</span><span><b>Escolher arquivo</b> do computador ou celular<br><small>ou arraste aqui</small></span></label>
      <h4 class="un-tit">Ou da caixa de entrada</h4>
      ${docs.length ? `<div class="iv-docs">${docs.map(x => `<button type="button" class="un-add" data-doc="${x.id}">${esc(x.nome)}
        <small>${esc(x.resumo || '')} · ${new Date(x.recebido_em).toLocaleDateString('pt-BR')}${x.status === 'processado' ? ' · já usado' : ''}</small></button>`).join('')}</div>`
        : '<p class="muted small-txt">Nenhum relatório de vendas na caixa de entrada. Mande pelo WhatsApp/e-mail ou arraste na Caixa de entrada.</p>'}
      <div class="dlg-err" hidden></div>
      <div class="actions"><button class="btn" data-fechar>Cancelar</button></div></div>`;
    const err = d.querySelector('.dlg-err');
    const falha = ex => { err.hidden = false; err.textContent = ex.message; };
    const enviar = async arq => {
      const fd = new FormData(); fd.append('arquivo', arq);
      d.querySelector('#iv-drop b').textContent = 'Lendo…';
      try {
        const r = await fetch('/api/cardapio/vendas/ler', { method: 'POST', headers: { 'x-cockpit': '1' }, body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(erroDe(j, r.status));
        passo2(j);
      } catch (ex) { falha(ex); d.querySelector('#iv-drop b').textContent = 'Escolher arquivo'; }
    };
    const drop = d.querySelector('#iv-drop'), inp = drop.querySelector('input');
    inp.onchange = () => inp.files[0] && enviar(inp.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && enviar(e.dataTransfer.files[0]); };
    d.onclick = async e => {
      if (e.target.closest('[data-fechar]')) return d.close();
      const b = e.target.closest('[data-doc]');
      if (!b) return;
      try { passo2(await api(`cardapio/vendas/documento/${b.dataset.doc}`)); } catch (ex) { falha(ex); }
    };
  };
  const passo2 = r => {
    const sg = r.sugestao, larg = Math.max(...r.linhas.slice(0, 50).map(l => l.length));
    const porCod = Object.fromEntries(ins.filter(i => i.dataset.cod).map(i => [normNome(i.dataset.cod), i]));
    // período do relatório × mês da tela (as vendas são gravadas no mês escolhido)
    const per = r.periodo, mesesPer = per ? [...new Set([per.de.slice(0, 7), per.ate.slice(0, 7)])] : [];
    const avisoPer = !per
      ? `<div class="alert warn small"><b>Não encontrei as datas no relatório.</b> Confira se ele é mesmo de <b>${nomeMes(mes)}</b> — as vendas serão gravadas nesse mês.</div>`
      : mesesPer.length > 1
      ? `<div class="alert warn small">Período do relatório: <b>${dm(per.de)}/${per.de.slice(0, 4)} a ${dm(per.ate)}/${per.ate.slice(0, 4)}</b> — pega <b>mais de um mês</b>.
          A engenharia de cardápio usa as vendas de cada mês; o ideal é exportar o relatório mês a mês. Se continuar, tudo vai para <b>${nomeMes(mes)}</b>.</div>`
      : mesesPer[0] !== mes
      ? `<div class="alert err small">Período do relatório: <b>${dm(per.de)} a ${dm(per.ate)}/${per.ate.slice(0, 4)}</b> — é de <b>${nomeMes(mesesPer[0])}</b>, mas a tela está em <b>${nomeMes(mes)}</b>.
          <button class="btn sm primary" data-irmes="${mesesPer[0]}">Lançar em ${nomeMes(mesesPer[0])}</button></div>`
      : `<div class="alert ok small">Período do relatório: <b>${dm(per.de)} a ${dm(per.ate)}/${per.ate.slice(0, 4)}</b> — ${nomeMes(mes)} ✓</div>`;
    const cab = sg.cabecalho != null ? r.linhas[sg.cabecalho] : null;
    const rotCol = j => `Coluna ${j + 1}${cab && cab[j] ? ` — ${cab[j]}` : ''}`;
    const opts = sel => Array.from({ length: larg }, (_, j) => `<option value="${j}" ${j === sel ? 'selected' : ''}>${esc(rotCol(j))}</option>`).join('');
    const mapa = Object.fromEntries(ins.map(i => [normNome(i.dataset.nome), i]));
    d.innerHTML = `<div class="dlg-body"><h3>${esc(r.nome)}</h3>
      ${avisoPer}
      <p class="sub">Confira quais colunas são o <b>produto</b> e a <b>quantidade vendida</b>. Linhas sem quantidade (títulos, totais) são ignoradas.</p>
      <div class="iv-cols"><label>Produto<select id="iv-p">${opts(sg.produto)}</select></label>
        <label>Quantidade<select id="iv-q">${opts(sg.quantidade)}</select></label>
        <label>Código do produto <small class="muted">(opcional)</small><select id="iv-c"><option value="">— Não tem —</option>${opts(sg.codigo)}</select></label></div>
      <div id="iv-prev"></div>
      <div class="dlg-err" hidden></div>
      <div class="actions"><button class="btn" data-voltar>← Outro arquivo</button><button class="btn primary" id="iv-ok">Preencher as vendas</button></div></div>`;
    const ler = () => {
      const cp = Number(d.querySelector('#iv-p').value), cq = Number(d.querySelector('#iv-q').value);
      const cc = d.querySelector('#iv-c').value === '' ? null : Number(d.querySelector('#iv-c').value);
      const soma = new Map(), sem = new Map(), codigos = new Map();   // codigos: produto → código lido no relatório
      let ign = 0;
      r.linhas.forEach((l, i) => {
        if (i === sg.cabecalho) return;
        const nome = (l[cp] || '').trim(), qtd = lerNum(String(l[cq] || '').replace(/[^\d.,-]/g, ''));
        if (!nome || !(qtd > 0) || /^total/i.test(nome)) return;
        const cod = cc != null ? String(l[cc] || '').trim() : '';
        const chave = normNome(nome), a = apel[chave];
        if (a?.ignorar) { ign += qtd; return; }                       // já marcado como "não é do cardápio"
        const alvo = (cod && porCod[normNome(cod)]) || mapa[chave] || (a && porPid[a.produto_id]);   // código primeiro
        if (alvo) {
          soma.set(alvo, (soma.get(alvo) || 0) + qtd);
          if (cod && !alvo.dataset.cod) codigos.set(alvo, cod);
        } else { const x = sem.get(nome) || { qtd: 0, cod }; x.qtd += qtd; sem.set(nome, x); }
      });
      return { soma, sem, ign, codigos };
    };
    const prever = () => {
      const { soma, sem, ign, codigos } = ler();
      d.querySelector('#iv-prev').innerHTML = `<p><b>${soma.size}</b> produto(s) reconhecido(s) do cadastro · <b>${[...soma.values()].reduce((a, b) => a + b, 0).toLocaleString('pt-BR')}</b> itens vendidos.
          ${ign ? `<br><span class="muted">${ign.toLocaleString('pt-BR')} item(ns) ignorado(s) — marcados antes como “não é do cardápio”.</span>` : ''}
          ${codigos.size ? `<br><span class="muted">${codigos.size} produto(s) sem código no cadastro vão receber o código do relatório.</span>` : ''}</p>
        ${sem.size ? `<details open><summary class="neg">${sem.size} nome(s) não reconhecido(s) — você revisa um por um a seguir</summary>
          <div class="iv-sem">${[...sem].map(([n, x]) => `<span>${esc(n)} <b>${x.qtd.toLocaleString('pt-BR')}</b></span>`).join('')}</div></details>` : ''}`;
    };
    d.querySelectorAll('select').forEach(sl => sl.onchange = prever);
    prever();
    d.onclick = async e => {
      if (e.target.closest('[data-voltar]')) return passo1();
      const ir = e.target.closest('[data-irmes]');
      if (ir) {   // troca para o mês do relatório e reabre esta importação lá
        if (document.querySelector('#sujo-v')?.textContent && !confirm('Há valores não salvos neste mês. Trocar de mês mesmo assim?')) return;
        VENDAS_IMPORT = r; d.close(); location.hash = `#/cardapio?aba=vendas&mes=${ir.dataset.irmes}`; return;
      }
      if (!e.target.closest('#iv-ok')) return;
      const { soma, sem, codigos } = ler();
      if (!soma.size && !sem.size) { const er = d.querySelector('.dlg-err'); er.hidden = false; er.textContent = 'Nenhum produto com quantidade nessas colunas.'; return; }
      soma.forEach((v, i) => { i.value = fmtQtd(v); });
      if (codigos.size) {   // grava o código do PDV/app onde o cadastro ainda não tinha
        try {
          await send('PUT', 'cardapio/vendas/codigos', { itens: [...codigos].map(([i, c]) => ({ produto_id: i.dataset.pid, codigo: c })) });
          codigos.forEach((c, i) => { i.dataset.cod = c; });
        } catch (_) { /* código é extra: não impede a importação */ }
      }
      depois(r.documento_id);
      if (sem.size) return revisarNomes([...sem], ins, d, depois, r.documento_id);
      d.close();
    };
  };
  if (inicial) passo2(inicial); else passo1();
  d.showModal();
}

// Nomes do relatório que não existem no cadastro: um por um, o usuário diz o que é.
// Produto existente ou "ignorar" fica lembrado (vendas_apelidos); produto novo é criado e entra na lista.
let VENDAS_PEND = null;   // valores digitados que sobrevivem ao recarregar a tela (produto novo precisa do seu campo)
async function revisarNomes(lista, ins, d, depois, docId) {
  const cats = await api('cad/categorias-itens?grupo=produto').catch(() => []);
  const produtos = ins.map(i => ({ id: i.dataset.pid, nome: i.dataset.nome })).sort((a, b) => a.nome.localeCompare(b.nome));
  const novos = {};   // produto criado agora → quantidade
  let k = 0;
  const titulo = n => n.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
  const fim = () => {
    d.close();
    if (Object.keys(novos).length) {   // recarrega para aparecer o campo do produto novo, mantendo o que já foi preenchido
      const mes = (location.hash.match(/mes=(\d{4}-\d{2})/) || [])[1];
      VENDAS_PEND = { mes, doc: docId || null, valores: { ...Object.fromEntries(ins.filter(i => i.value).map(i => [i.dataset.pid, i.value])), ...novos } };
      FLASH = `${Object.keys(novos).length} produto(s) novo(s) no cardápio. Confira as quantidades e salve.`;
      render();
    }
  };
  const passo = () => {
    if (k >= lista.length) return fim();
    const [nome, { qtd, cod }] = lista[k];
    d.innerHTML = `<div class="dlg-body"><div class="eyebrow">Nome não reconhecido · ${k + 1} de ${lista.length}</div>
      <h3>“${esc(nome)}” <small class="muted">${qtd.toLocaleString('pt-BR')} vendido(s)</small></h3>
      <p class="sub">O que é isso? O app lembra a resposta nas próximas importações.</p>
      <div class="rv-opcoes">
        <label class="rv-op"><input type="radio" name="rv" value="existe"> <b>É um produto que já está no cardápio</b> <small>com outro nome</small></label>
        <div class="rv-sub" data-sub="existe" hidden><select id="rv-prod"><option value="">— Escolha o produto —</option>
          ${produtos.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></div>
        <label class="rv-op"><input type="radio" name="rv" value="novo"> <b>Adicionar ao cardápio</b> <small>produto novo</small></label>
        <div class="rv-sub cad-grid" data-sub="novo" hidden>
          <label class="span2">Nome<input id="rv-nome" value="${esc(titulo(nome))}" maxlength="120"></label>
          ${cod ? `<p class="small-txt span2">Código no sistema: <b>${esc(cod)}</b> — vai junto para o cadastro.</p>` : ''}
          <label>Categoria<select id="rv-cat"><option value="">— Sem categoria —</option>${cats.filter(c => c.ativo).map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')}</select></label>
          <label>Preço de venda (R$)<input id="rv-preco" class="money" inputmode="decimal" placeholder="0,00"></label>
          <fieldset class="checks span2"><legend>Vendido no</legend>${['Salão', 'Delivery'].map(c => `<label><input type="checkbox" name="rv-can" value="${c}" checked> ${c}</label>`).join('')}</fieldset>
          <p class="muted small-txt span2">A ficha técnica você completa depois em Cadastros › Produtos.</p></div>
        <label class="rv-op"><input type="radio" name="rv" value="ignorar"> <b>Não é produto do cardápio</b> <small>ignorar sempre (ex.: ponto do hambúrguer, adicional, taxa)</small></label>
      </div>
      <div class="dlg-err" hidden></div>
      <div class="actions"><button class="btn" data-pular>Pular por agora</button><button class="btn primary" data-ok>Confirmar</button></div></div>`;
    const err = d.querySelector('.dlg-err');
    d.querySelectorAll('[name=rv]').forEach(r => r.onchange = () => d.querySelectorAll('[data-sub]').forEach(x => { x.hidden = x.dataset.sub !== r.value; }));
    d.onclick = async e => {
      if (e.target.closest('[data-pular]')) { k++; return passo(); }
      if (!e.target.closest('[data-ok]')) return;
      const op = d.querySelector('[name=rv]:checked')?.value;
      const chave = { nome, nome_norm: normNome(nome) };
      try {
        if (!op) throw new Error('Escolha uma das opções (ou “Pular por agora”).');
        if (op === 'existe') {
          const pid = d.querySelector('#rv-prod').value;
          if (!pid) throw new Error('Escolha o produto.');
          await send('PUT', 'cardapio/vendas/apelidos', { ...chave, produto_id: pid });
          const i = ins.find(x => x.dataset.pid === pid);
          if (cod && !i.dataset.cod) { try { await send('PUT', 'cardapio/vendas/codigos', { itens: [{ produto_id: pid, codigo: cod }] }); i.dataset.cod = cod; } catch (_) { /* extra */ } }
          i.value = fmtQtd((lerNum(i.value) || 0) + qtd);
        } else if (op === 'novo') {
          const nomeP = d.querySelector('#rv-nome').value.trim();
          if (!nomeP) throw new Error('Informe o nome do produto.');
          const preco = d.querySelector('#rv-preco').value.trim();
          const p = await send('POST', 'cad/produtos', { nome: nomeP, categoria_id: d.querySelector('#rv-cat').value || null, codigo_pdv: cod || null,
            preco_venda: preco ? lerMoeda(preco) : null, canais: [...d.querySelectorAll('[name=rv-can]:checked')].map(c => c.value) });
          await send('PUT', 'cardapio/vendas/apelidos', { ...chave, produto_id: p.id });
          novos[p.id] = fmtQtd((lerNum(novos[p.id]) || 0) + qtd);
        } else {
          await send('PUT', 'cardapio/vendas/apelidos', { ...chave, ignorar: true });
        }
        depois(); k++; passo();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    };
  };
  passo();
}

// Cola linhas "produto [tab ou ;] quantidade" (copiadas do relatório do PDV/app) e preenche os campos pelo nome.
function colarVendas(ins, depois) {
  const d = document.createElement('dialog');
  d.className = 'dlg dlg-largo';
  d.innerHTML = `<form method="dialog" class="dlg-body"><h3>Colar vendas do relatório</h3>
    <p class="sub">Copie do relatório (Sischef, Anota Aí, planilha) as colunas <b>produto</b> e <b>quantidade</b> e cole aqui, uma linha por produto.
      Nomes iguais aos do cadastro são reconhecidos (sem diferenciar acentos e maiúsculas). Quantidades do mesmo produto são somadas.</p>
    <textarea id="txt" rows="10" style="width:100%;font:inherit;font-size:12.5px" placeholder="Cheese Burger	42&#10;Batata Frita;18"></textarea>
    <div id="res" class="small-txt"></div>
    <div class="actions"><button class="btn" value="x">Cancelar</button><button class="btn primary" id="ok" type="button">Preencher</button></div></form>`;
  document.body.append(d); d.showModal();
  d.addEventListener('close', () => d.remove());
  const mapa = Object.fromEntries(ins.map(i => [normNome(i.dataset.nome), i]));
  d.querySelector('#ok').onclick = () => {
    const soma = new Map(), sem = [];
    d.querySelector('#txt').value.split(/\r?\n/).forEach(l => {
      const m = l.trim().match(/^(.+?)[\t;]+\s*([\d.,]+)\s*$/) || l.trim().match(/^(.+?)\s+([\d.,]+)\s*$/);
      if (!m) return;
      const alvo = mapa[normNome(m[1])];
      if (!alvo) { sem.push(m[1].trim()); return; }
      soma.set(alvo, (soma.get(alvo) || 0) + (lerNum(m[2]) || 0));
    });
    soma.forEach((v, i) => { i.value = fmtQtd(v); });
    depois();
    d.querySelector('#res').innerHTML = `<p><b>${soma.size}</b> produto(s) preenchido(s).</p>${sem.length
      ? `<p class="dlg-err">Não reconhecidos (${sem.length}) — preencha à mão ou ajuste o nome no cadastro: ${sem.map(esc).join(', ')}</p>` : ''}`;
    if (!sem.length) setTimeout(() => d.close(), 900);
  };
}

const ABA_CARDAPIO = { engenharia: abaEngenharia, precificacao: abaPrecificacao, vendas: abaVendasProduto };
PAGES['cardapio'] = {
  eyebrow: 'Cardápio', title: 'Cardápio', lede: 'Engenharia de cardápio, precificação e vendas por produto.', periodo: false,
  async render(v, p) {
    const aba = ABA_CARDAPIO[p.aba] ? p.aba : 'engenharia';
    document.getElementById('title').textContent = { engenharia: 'Engenharia de cardápio', precificacao: 'Precificação', vendas: 'Vendas por produto' }[aba];
    const flash = FLASH; FLASH = '';
    v.innerHTML = `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}<section id="card-box" class="view"></section>`;
    await ABA_CARDAPIO[aba](v.querySelector('#card-box'), p);
  },
};
