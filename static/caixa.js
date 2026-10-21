// Fechamento de caixa: substitui a aba diária da planilha "Fechamento de Caixa".
// Mesmas fórmulas da planilha (caixa.py); roda em paralelo, com comparação lado a lado.

const CANAIS_CX = ['Salão', 'Delivery'];
const EQUIPE_ROT = { 'Salão': 'Free lances', 'Delivery': 'Motoboys' };
let CFG_CX = { formas: [], itens: [] };   // formas de pagamento e itens da conferência (cadastro)
const GAVETA_CX = { 'Salão': 'CAIXA SALÃO DEVE TER', 'Delivery': 'CAIXA DELIVERY DEVE TER' };
const nz = v => (typeof v === 'number' ? v : lerMoeda(v)) || 0;   // aceita 1.234,56
const r2 = v => Math.round(v * 100) / 100;

function calcCaixa(canais) {
  const tot = {};
  CANAIS_CX.forEach(c => {
    const k = canais[c] || {};
    tot[c] = {
      total: r2(Object.values(k.formas || {}).reduce((s, v) => s + nz(v), 0)),
      equipe: r2((k.equipe || []).reduce((s, e) => s + nz(e.valor), 0)),
      // só o pago em dinheiro sai da gaveta (PIX e "pagar outro dia" não) — mesma regra de caixa.calcula
      equipe_dinheiro: r2((k.equipe || []).filter(e => (e.forma || 'dinheiro') === 'dinheiro').reduce((s, e) => s + nz(e.valor), 0)),
    };
  });
  const val = (c, f) => nz(canais[c]?.formas?.[f]);
  const deve = {};
  CANAIS_CX.forEach(c => {
    const din = CFG_CX.formas.filter(f => f.conferencia === 'gaveta').reduce((s, f) => s + val(c, f.nome), 0);
    deve[GAVETA_CX[c]] = r2(nz(canais[c]?.troco_inicial) + din - tot[c].equipe_dinheiro - nz(canais[c]?.diversos));
  });
  CFG_CX.itens.slice(CANAIS_CX.length).forEach(it => {
    deve[it.item] = r2(CANAIS_CX.reduce((s, c) => s + CFG_CX.formas.filter(f => f.conferencia === it.rotulo)
      .reduce((t, f) => t + val(c, f.nome), 0), 0));
  });
  return { canais: tot, total_dia: r2(tot['Salão'].total + tot['Delivery'].total), deve_ter: deve };
}

const diaPadrao = () => { const d = new Date(); if (d.getHours() < 12) d.setDate(d.getDate() - 1); return iso(d); };
const DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
let CX_SUJO = false;
window.addEventListener('beforeunload', e => { if (CX_SUJO) e.preventDefault(); });

function calendario(mes, dias, sel) {
  const [a, m] = mes.split('-').map(Number);
  const primeiro = new Date(a, m - 1, 1).getDay();
  const hoje = hojeIso();
  const prev = iso(new Date(a, m - 2, 1)).slice(0, 7), prox = iso(new Date(a, m, 1)).slice(0, 7);
  const rot = d => {
    if (d.status === 'fechado') return ['ok', 'Fechado'];
    if (d.status === 'nao_abriu') return ['off', 'Não abriu'];
    if (d.status === 'rascunho') return ['draft', 'Rascunho'];
    if (d.planilha_nao_abriu) return ['off', 'Não abriu'];
    if (d.total_planilha != null) return ['sheet', 'Só planilha'];
    return ['', ''];
  };
  return `<div class="cal-head">
      <button class="btn sm" data-mes="${prev}" aria-label="Mês anterior">‹</button>
      <b>${MESES_LONGOS[m - 1]} ${a}</b>
      <button class="btn sm" data-mes="${prox}" aria-label="Próximo mês">›</button>
    </div>
    <div class="cal">${['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map(x => `<span class="cal-dow">${x}</span>`).join('')}
      ${'<span></span>'.repeat(primeiro)}
      ${dias.map(d => {
        const [cls, txt] = rot(d);
        const futuro = d.data > hoje;
        return `<button class="cal-d ${cls} ${d.data === sel ? 'sel' : ''}" data-d="${d.data}" ${futuro ? 'disabled' : ''}
          title="${dm(d.data)}${txt ? ' · ' + txt : ''}${d.diverge ? ' · diverge da planilha' : ''}">
          <span class="n">${Number(d.data.slice(8))}</span>${txt ? `<span class="t">${txt}</span>` : ''}${d.diverge ? '<span class="dv" aria-label="diverge da planilha">≠</span>' : ''}
        </button>`;
      }).join('')}
    </div>
    <div class="cal-leg"><span><i class="ok"></i>Fechado no app</span><span><i class="draft"></i>Rascunho</span><span><i class="sheet"></i>Só na planilha</span><span><i class="off"></i>Não abriu</span><span><b>≠</b> diverge da planilha</span></div>`;
}

function blocoCanal(c, k, troco, travado) {
  const dis = travado ? 'disabled' : '';
  const fechado = k.status === 'fechado';
  const din = (campo, val, extra = '') => `<input class="money" inputmode="decimal" data-c="${c}" data-k="${campo}" value="${fmtMoeda(val ?? '')}" placeholder="0,00" ${dis} ${extra}>`;
  return `<div class="card canal ${fechado ? 'canal-fechado' : ''}" data-canal="${c}" ${travado ? 'data-trav="1"' : ''}>
    <div class="canal-head"><h3>${c}</h3><span class="canal-st ${fechado ? 'ok' : ''}">${fechado ? '✓ fechado' : k.status === 'rascunho' ? 'rascunho' : 'em aberto'}</span>
      <span class="canal-tot" data-tot="${c}"></span></div>
    <div class="cx-grid">
      <label>Responsável<select data-c="${c}" data-k="responsavel" ${dis}>${opcoesResp(k.responsavel)}</select>
        ${travado || !ehAdmin() ? '' : `<button type="button" class="link-mini" data-addresp="${c}">＋ Cadastrar na equipe</button>`}</label>
      <label>Troco inicial${din('troco_inicial', k.troco_inicial ?? troco)}</label>
    </div>
    <div class="cx-sec">Recebimentos</div>
    <label class="forma gaveta-contada"><span>Fechamento em dinheiro <small class="muted">(com o troco)</small></span>${din('fechamento_dinheiro', k.fechamento_dinheiro ?? '')}</label>
    <div class="formas">${CFG_CX.formas.filter(f => f.canais.includes(c) || k.formas?.[f.nome]).map(fo => {
      const f = fo.nome, calc = fo.conferencia === 'gaveta';   // dinheiro de venda = gaveta − troco (o troco não é faturamento)
      return `<label class="forma ${calc ? 'calc' : ''}"><span>${esc(f)}${calc ? ' <small class="muted">= fechamento − troco</small>' : ''}</span>
      <input class="money" inputmode="decimal" data-c="${c}" data-forma="${esc(f)}" ${calc ? 'data-calc readonly tabindex="-1"' : ''} value="${fmtMoeda(k.formas?.[f] || '')}" placeholder="0,00" ${dis}></label>`;
    }).join('')}
    </div>
    <div class="cx-sec">${EQUIPE_ROT[c]} <span class="muted" data-eqtot="${c}"></span></div>
    <div class="equipe" data-equipe="${c}">${(k.equipe || []).map(e => linhaEquipe(c, e, dis)).join('')}</div>
    ${travado ? '' : `<div class="eq-add"><button type="button" class="btn sm" data-addeq="${c}">＋ Adicionar pessoa</button>
      ${ehAdmin() ? `<button type="button" class="link-mini" data-cadeq="${c}">＋ Cadastrar ${c === 'Delivery' ? 'motoboy' : 'free lance'} novo</button>` : ''}</div>`}
    <div class="cx-grid">
      <label>Diversos (saídas do caixa)${din('diversos', k.diversos ?? '')}</label>
      <label class="span2">Observações<textarea data-c="${c}" data-k="observacao" rows="2" maxlength="1000" ${dis}>${esc(k.observacao ?? '')}</textarea></label>
    </div>
    <div class="canal-foot">${fechado
      ? `<span class="muted small-txt">Fechado${k.fechado_por ? ` por ${esc(k.fechado_por)}` : ''}${k.fechado_em ? ` em ${new Date(k.fechado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</span>
         ${ehAdmin() ? `<button type="button" class="btn sm" data-reabrircanal="${c}">Reabrir ${c.toLowerCase()}</button>` : ''}`
      : travado ? '' : `<span class="muted small-txt" data-sujo="${c}"></span>
         <button type="button" class="btn sm" data-salvarcanal="${c}">Salvar rascunho</button>
         <button type="button" class="btn sm primary" data-fecharcanal="${c}">Fechar caixa do ${c.toLowerCase()}</button>`}</div>
  </div>`;
}
let CX_EQUIPE = { responsaveis: [], outros: [] };
let CX_EQ_CANAL = {};   // por canal: quem costuma aparecer (free lances no salão, motoboys no delivery)
// pessoa da equipe sempre escolhida do cadastro (nome livre criava duplicados)
function opcoesEquipe(c, atual) {
  const doCanal = CX_EQ_CANAL[c] || [];
  const outros = [...new Set([...Object.values(CX_EQ_CANAL).flat(), ...CX_EQUIPE.responsaveis, ...CX_EQUIPE.outros])].filter(n => !doCanal.includes(n)).sort();
  const op = n => `<option value="${esc(n)}" ${n === atual ? 'selected' : ''}>${esc(n)}</option>`;
  return `<option value="">Escolha a pessoa…</option>`
    + `<optgroup label="${EQUIPE_ROT[c]}">${doCanal.map(op).join('')}</optgroup>`
    + (outros.length ? `<optgroup label="Outros da equipe">${outros.map(op).join('')}</optgroup>` : '')
    + (atual && !doCanal.includes(atual) && !outros.includes(atual) ? `<optgroup label="Fora do cadastro"><option value="${esc(atual)}" selected>${esc(atual)}</option></optgroup>` : '');
}
function opcoesResp(atual) {
  const todos = [...CX_EQUIPE.responsaveis, ...CX_EQUIPE.outros];
  const op = n => `<option value="${esc(n)}" ${n === atual ? 'selected' : ''}>${esc(n)}</option>`;
  return `<option value="">Selecione alguém da equipe…</option>`
    + (CX_EQUIPE.responsaveis.length ? `<optgroup label="Responsáveis de caixa">${CX_EQUIPE.responsaveis.map(op).join('')}</optgroup>` : '')
    + (CX_EQUIPE.outros.length ? `<optgroup label="Outros da equipe">${CX_EQUIPE.outros.map(op).join('')}</optgroup>` : '')
    + (atual && !todos.includes(atual) ? `<optgroup label="Fora do cadastro (só leitura)"><option value="${esc(atual)}" selected>${esc(atual)}</option></optgroup>` : '');
}
function definirResp(sel, nome) {
  if (nome && ![...sel.options].some(o => o.value === nome)) {
    sel.insertAdjacentHTML('beforeend', `<optgroup label="Fora do cadastro (só leitura)"><option value="${esc(nome)}">${esc(nome)}</option></optgroup>`);
  }
  sel.value = nome || '';
}

const FORMA_EQ = { dinheiro: 'Pago em dinheiro (da gaveta)', pix: 'PIX a fazer', pendente: 'Pagar outro dia' };
const linhaEquipe = (c, e = {}, dis = '') => {
  const forma = e.forma || 'dinheiro';
  // dia fechado: mostra se o PIX / pagamento posterior já foi feito; o admin marca como pago
  const situacao = dis && forma !== 'dinheiro' ? (e.pago_em
      ? `<span class="eq-pago ok">✓ pago${e.pago_por_nome ? ` por ${esc(e.pago_por_nome)}` : ''} em ${dm(e.pago_em.slice(0, 10))}</span>
         ${ehAdmin() ? `<button type="button" class="link-mini" data-pago="${c}|${e.linha}|0">desfazer</button>` : ''}`
      : `<span class="eq-pago">${forma === 'pix' ? 'PIX ainda não feito' : 'ainda não pago'}</span>
         ${ehAdmin() ? `<button type="button" class="btn sm primary" data-pago="${c}|${e.linha}|1">Marcar como pago</button>` : ''}`) : '';
  return `<div class="eq-row ${forma !== 'dinheiro' ? 'fora-gaveta' : ''}">
  <select data-eqnome ${dis} aria-label="Pessoa">${opcoesEquipe(c, e.nome)}</select>
  <input class="money" inputmode="decimal" placeholder="0,00" value="${fmtMoeda(e.valor ?? '')}" data-eqvalor ${dis}>
  <select data-eqforma ${dis} aria-label="Como foi pago">${Object.entries(FORMA_EQ).map(([k, r]) => `<option value="${k}" ${k === forma ? 'selected' : ''}>${r}</option>`).join('')}</select>
  ${dis ? '' : `<button type="button" class="btn sm" data-rmeq aria-label="Remover">×</button>`}
  ${situacao ? `<div class="eq-sit">${situacao}</div>` : ''}</div>`;
};

// Dinheiro de venda = contado na gaveta − troco inicial (mesma regra da planilha e do servidor)
function syncDinheiro(v) {
  CANAIS_CX.forEach(c => {
    const card = v.querySelector(`[data-canal="${c}"]`);
    if (!card) return;
    const fech = card.querySelector('[data-k="fechamento_dinheiro"]'), troco = card.querySelector('[data-k="troco_inicial"]');
    card.querySelectorAll('[data-calc]').forEach(i => {
      i.value = fech.value.trim() === '' ? '' : fmtMoeda(Math.max(r2(nz(fech.value) - nz(troco.value)), 0));
    });
  });
}

function coletar(v) {
  syncDinheiro(v);
  const canais = {};
  CANAIS_CX.forEach(c => {
    const card = v.querySelector(`[data-canal="${c}"]`);
    const val = k => card.querySelector(`[data-k="${k}"]`).value;
    canais[c] = {
      responsavel: val('responsavel').trim() || null,
      troco_inicial: nz(val('troco_inicial')),
      diversos: nz(val('diversos')),
      fechamento_dinheiro: val('fechamento_dinheiro') === '' ? null : nz(val('fechamento_dinheiro')),
      observacao: val('observacao').trim() || null,
      formas: Object.fromEntries([...card.querySelectorAll('[data-forma]')].map(i => [i.dataset.forma, nz(i.value)])),
      equipe: [...card.querySelectorAll('.eq-row')].map(r => ({ nome: r.querySelector('[data-eqnome]').value.trim(), valor: nz(r.querySelector('[data-eqvalor]').value),
                                                                  forma: r.querySelector('[data-eqforma]').value }))
        .filter(e => e.nome || e.valor),
    };
  });
  const conferencia = Object.fromEntries([...v.querySelectorAll('[data-real]')].map(i => [i.dataset.real, i.value === '' ? null : nz(i.value)]));
  return { canais, conferencia };
}

function comparacao(app, plan, calcPlan) {
  if (!plan) return '<div class="empty">A planilha não tem este dia (ou o ETL ainda não rodou depois do fechamento).</div>';
  const calc = calcCaixa(app.canais);
  const linhas = [];
  const cmp = (rot, a, b, sempre) => linhas.push({ rot, a: nz(a), b: nz(b), ok: Math.abs(nz(a) - nz(b)) < 0.01, sempre: sempre && (nz(a) || nz(b)) });
  const nomes = plan.nomes || {};
  CANAIS_CX.forEach(c => {
    const pa = app.canais[c] || {}, pp = plan.canais[c] || {};
    cmp(`${c} · total`, calc.canais[c].total, pp.total, true);
    // forma por forma, lado a lado (ex.: "Crédito Pag Seguro" no app = "Crédito" na planilha)
    CFG_CX.formas.forEach(({ nome: f }) => cmp(`${c} · ${f}${nomes[f] ? ` (planilha: ${nomes[f]})` : ''}`, pa.formas?.[f], pp.formas?.[f], true));
    cmp(`${c} · ${EQUIPE_ROT[c].toLowerCase()}`, calc.canais[c].equipe, pp.pagamento_equipe);
    cmp(`${c} · troco inicial`, pa.troco_inicial, pp.troco_inicial);
    cmp(`${c} · diversos`, pa.diversos, pp.diversos);
  });
  // só a gaveta: cartão e apps a planilha agrupa de outro jeito (e os valores de cima já mostram se bate)
  CFG_CX.itens.filter(it => it.quem !== 'admin').forEach(it => cmp(`Conferência · ${it.rotulo} (real)`, app.conferencia[it.item], plan.conferencia[it.item]?.valor_real));
  const dif = linhas.filter(l => !l.ok);
  return `${dif.length ? `<div class="alert warn small">${dif.length} diferença(s) entre o app e a planilha.</div>` : '<div class="alert ok small">Tudo bate com a planilha ✓</div>'}
    <div class="table-wrap"><table><thead><tr><th>Item</th><th class="n">App</th><th class="n">Planilha</th><th></th></tr></thead><tbody>
    ${linhas.filter(l => !l.ok || l.sempre).map(l => `<tr class="${l.ok ? '' : 'venc'}"><td>${esc(l.rot)}</td>
      <td class="n">${money(l.a)}</td><td class="n">${money(l.b)}</td><td>${l.ok ? '✓' : '≠'}</td></tr>`).join('')}
    </tbody></table></div>
    ${calcPlan ? `<p class="muted small-txt">Total do dia na planilha: ${money(calcPlan.total_dia)}</p>` : ''}`;
}

PAGES['caixa'] = {
  eyebrow: 'Vendas', title: 'Fechamento de caixa',
  lede: 'Feche o dia por canal. A conferência é calculada com as mesmas fórmulas da planilha.', periodo: false,
  async render(v, p) {
    const data = p.d || diaPadrao();
    const mes = p.m || data.slice(0, 7);
    const [r, cal] = await Promise.all([api(`fin/caixa/dia/${data}`), api(`fin/caixa/mes?mes=${mes}`)]);
    CFG_CX = { formas: r.formas, itens: r.itens };
    CX_EQUIPE = { responsaveis: r.responsaveis, outros: r.equipe_geral || [] };
    CX_EQ_CANAL = r.equipe;
    CX_SUJO = false;
    const app = r.app;
    const naoAbriu = app?.status === 'nao_abriu';
    const base = app && !naoAbriu ? app : { canais: {}, conferencia: {} };
    // salão e delivery fecham separados: cada canal trava sozinho
    const travCanal = c => naoAbriu || base.canais[c]?.status === 'fechado';
    const algumFechado = CANAIS_CX.some(c => base.canais[c]?.status === 'fechado');
    const tudoTravado = CANAIS_CX.every(travCanal);
    const confAdmin = ehAdmin() && app?.status === 'fechado' && !app.conferido_em;   // admin digita cartão / apps ao conferir
    const dObj = parseD(data);
    const statusTxt = !app ? (r.planilha ? 'Ainda não fechado no app · a planilha já tem este dia' : (r.planilha_nao_abriu ? `Planilha marca que não abriu: ${r.planilha_nao_abriu}` : 'Ainda não fechado'))
      : app.status === 'fechado' ? `Fechado em ${new Date(app.fechado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
      : app.status === 'nao_abriu' ? `Marcado como "não abriu": ${app.motivo}`
      : `${CANAIS_CX.map(c => `${c}: ${base.canais[c]?.status === 'fechado' ? 'fechado' : base.canais[c] ? 'rascunho' : 'não lançado'}`).join(' · ')}`;
    const flash = FLASH; FLASH = '';
    v.innerHTML = `
      ${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      <div class="cx-top">
        <div class="card cal-card">${calendario(mes, cal.dias, data)}</div>
        <div class="card cx-status">
          <div class="eyebrow">${DIAS_LONGOS[dObj.getDay()]}</div>
          <div class="cx-data">${dm(data)}/${data.slice(0, 4)}</div>
          <div class="cx-st st-${app?.status || 'vazio'}">${esc(statusTxt)}</div>
          ${app?.status === 'fechado' ? (app.conferido_em
            ? `<div class="cx-conf ok">✓ Conferido por ${esc(app.conferido_nome || '—')} em ${new Date(app.conferido_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</div>`
            : `<div class="cx-conf">Aguardando conferência do administrador</div>`) : ''}
          <div class="cx-total">Total do dia <b data-totdia></b></div>
          <div class="cx-btns">
            ${!tudoTravado && r.planilha ? '<button type="button" class="btn sm" id="copiar">Copiar da planilha</button>' : ''}
            ${!naoAbriu && !algumFechado ? '<button type="button" class="btn sm" id="naoabriu">Marcar "não abriu"</button>' : ''}
            ${confAdmin ? '<button type="button" class="btn sm primary" id="conferir">Marcar como conferido</button>' : ''}
            ${naoAbriu && ehAdmin() ? '<button type="button" class="btn sm" id="reabrir">Reabrir</button>' : ''}
          </div>
        </div>
      </div>
      ${app?.status === 'nao_abriu' ? '' : `
      <div class="grid g-1-1">${CANAIS_CX.map(c => blocoCanal(c, base.canais[c] || {}, r.troco_sugerido[c], travCanal(c))).join('')}</div>
      <div class="grid g-1-1">
        <div class="card"><h3>Conferência</h3><div class="sub">"Deve ter" é calculado. A gaveta é conferida por quem fecha cada canal;
          cartão, pix direto e apps (somam os dois canais) o administrador confere depois, pelos relatórios.</div>
          <div class="table-wrap"><table class="conf"><thead><tr><th>Item</th><th class="n">Deve ter</th><th class="n">Valor real</th><th class="n">Diferença</th></tr></thead>
          <tbody>${r.itens.filter(i => i.quem !== 'admin' || ehAdmin()).map(({ item: it, rotulo, dica, quem, canal }, i, arr) => {
            // gaveta: quem fecha o canal digita; depois de fechado, o admin ainda pode lançar/corrigir na conferência
            const pode = quem === 'admin' ? confAdmin : !travCanal(canal) || confAdmin;
            const titulo = quem === 'admin' && arr[i - 1]?.quem !== 'admin'
              ? `<tr class="conf-sep"><td colspan="4">Conferência do administrador${app?.status === 'fechado' ? '' : ' — libera quando salão e delivery estiverem fechados'}</td></tr>` : '';
            return `${titulo}<tr>
            <td>${esc(rotulo)}${dica ? `<small>${esc(dica)}</small>` : ''}</td>
            <td class="n" data-deve="${esc(it)}"></td>
            <td class="n"><input class="money" inputmode="decimal" data-real="${esc(it)}" value="${fmtMoeda(base.conferencia[it] ?? '')}" placeholder="0,00" ${pode ? '' : 'disabled'}>
              ${pode ? `<button type="button" class="btn sm" data-igual="${esc(it)}" title="Usar o valor do deve ter">=</button>` : ''}</td>
            <td class="n" data-dif="${esc(it)}"></td></tr>`;
          }).join('')}</tbody></table></div>
        </div>
        <div class="card"><h3>Comparação com a planilha</h3><div class="sub">Período em paralelo: o cockpit ainda usa a planilha</div>
          <div id="cmp"></div></div>
      </div>
      ${app?.status === 'fechado' && ehAdmin() ? '<div class="card fx-card" id="fluxo-cx"><div class="loading">Carregando…</div></div>' : ''}`}
      `;
    const fxBox = v.querySelector('#fluxo-cx');
    if (fxBox) painelFluxoCaixa(fxBox, data);

    const ir = mudar => {
      if (CX_SUJO && !confirm('Há alterações não salvas neste dia. Sair mesmo assim?')) return;
      CX_SUJO = false;
      location.hash = `#/caixa?${new URLSearchParams({ d: data, ...mudar })}`;
    };
    v.querySelectorAll('[data-d]').forEach(b => b.onclick = () => ir({ d: b.dataset.d, m: b.dataset.d.slice(0, 7) }));
    v.querySelectorAll('[data-mes]').forEach(b => b.onclick = () => ir({ m: b.dataset.mes }));

    const atualizar = () => {
      if (app?.status === 'nao_abriu') { v.querySelector('[data-totdia]').textContent = '—'; return; }
      const st = coletar(v);
      const c = calcCaixa(st.canais);
      v.querySelector('[data-totdia]').textContent = money(c.total_dia);
      CANAIS_CX.forEach(k => {
        v.querySelector(`[data-tot="${k}"]`).textContent = money(c.canais[k].total);
        const fora = r2(c.canais[k].equipe - c.canais[k].equipe_dinheiro);
        v.querySelector(`[data-eqtot="${k}"]`).textContent = c.canais[k].equipe
          ? `· ${money(c.canais[k].equipe)}${fora ? ` (${money(fora)} fora da gaveta: PIX ou outro dia)` : ''}` : '';
      });
      Object.entries(c.deve_ter).forEach(([it, dv]) => {
        const deve = v.querySelector(`[data-deve="${it}"]`);
        if (!deve) return;   // item do administrador (escondido para o responsável do caixa)
        deve.textContent = money(dv);
        const real = st.conferencia[it];
        const cel = v.querySelector(`[data-dif="${it}"]`);
        if (real == null) { cel.textContent = '—'; cel.className = 'n'; return; }
        const d = r2(dv - real);
        cel.textContent = money(d);
        cel.className = `n ${Math.abs(d) < 0.01 ? 'zero' : 'neg'}`;
      });
      v.querySelector('#cmp').innerHTML = comparacao(st, r.planilha, r.calc_planilha);
    };
    const diaria = sel => {   // escolheu a pessoa: sugere a diária do cadastro
      const valor = sel.closest('.eq-row').querySelector('[data-eqvalor]');
      if (!valor.value && r.diarias[sel.value]) valor.value = fmtMoeda(r.diarias[sel.value]);
    };
    v.onchange = e => {
      if (e.target.matches('[data-eqnome]')) diaria(e.target);
      if (e.target.matches('select[data-k="responsavel"], [data-eqnome]')) { sujar(); atualizar(); }
    };
    const sujar = () => { CX_SUJO = true; v.querySelectorAll('[data-sujo]').forEach(s => { s.textContent = 'Alterações não salvas'; }); };
    v.oninput = e => {
      if (!e.target.matches('input, textarea')) return;
      sujar(); atualizar();
    };
    v.onclick = e => {
      const add = e.target.closest('[data-addeq]');
      if (add) {
        v.querySelector(`[data-equipe="${add.dataset.addeq}"]`).insertAdjacentHTML('beforeend', linhaEquipe(add.dataset.addeq));
        v.querySelector(`[data-equipe="${add.dataset.addeq}"] .eq-row:last-child select`).focus();
      }
      const cad = e.target.closest('[data-cadeq]');
      if (cad) {   // pessoa nova: cadastra na equipe e já entra numa linha
        const c = cad.dataset.cadeq;
        dialogoCad({
          titulo: `Novo ${c === 'Delivery' ? 'motoboy' : 'free lance'}`, campos: camposPessoa('equipe'),
          valores: { papeis: [c === 'Delivery' ? 'motoboy' : 'free_lance_salao'] },
          salvar: d => send('POST', 'cad/pessoas', { ...d, ...papeisBanco(d.papeis) }),
          depois: nova => {
            (CX_EQ_CANAL[c] ||= []).push(nova.nome);
            if (nova.diaria_padrao) r.diarias[nova.nome] = Number(nova.diaria_padrao);
            v.querySelectorAll(`[data-equipe="${c}"] [data-eqnome]`).forEach(sel => { const a = sel.value; sel.innerHTML = opcoesEquipe(c, a); });
            v.querySelector(`[data-equipe="${c}"]`).insertAdjacentHTML('beforeend', linhaEquipe(c, { nome: nova.nome }));
            diaria(v.querySelector(`[data-equipe="${c}"] .eq-row:last-child [data-eqnome]`));
            sujar(); atualizar();
          },
        });
      }
      const rm = e.target.closest('[data-rmeq]');
      if (rm) { rm.closest('.eq-row').remove(); sujar(); atualizar(); }
      const addr = e.target.closest('[data-addresp]');
      if (addr) {
        dialogoCad({
          titulo: 'Nova pessoa da equipe', campos: camposPessoa('equipe'), valores: { papeis: ['responsavel_caixa'] },
          salvar: d => send('POST', 'cad/pessoas', { ...d, ...papeisBanco(d.papeis) }),   // free lance cozinha/salão → papel + área
          depois: nova => {
            if (nova.papeis.includes('responsavel_caixa')) CX_EQUIPE.responsaveis.push(nova.nome); else CX_EQUIPE.outros.push(nova.nome);
            v.querySelectorAll('select[data-k="responsavel"]').forEach(sel => {
              const atual = sel.value; sel.innerHTML = opcoesResp(atual);
            });
            definirResp(v.querySelector(`[data-canal="${addr.dataset.addresp}"] select[data-k="responsavel"]`), nova.nome);
            sujar(); atualizar();
          },
        });
      }
      const ig = e.target.closest('[data-igual]');
      if (ig) {
        const inp = v.querySelector(`[data-real="${ig.dataset.igual}"]`);
        inp.value = fmtMoeda(calcCaixa(coletar(v).canais).deve_ter[ig.dataset.igual]);
        sujar(); atualizar();
      }
    };

    const gravar = async (status, extra = {}) => {   // só "não abriu" (dia inteiro)
      try {
        await send('PUT', `fin/caixa/dia/${data}`, { status, canais: {}, conferencia: {}, ...extra });
        CX_SUJO = false; FLASH = `${dm(data)} marcado como "não abriu".`; render();
      } catch (err) { alert(err.message); }
    };
    const gravarCanal = async (c, status) => {
      const st = coletar(v);
      try {
        await send('PUT', `fin/caixa/dia/${data}/canal/${encodeURIComponent(c)}`,
          { status, canal: st.canais[c], gaveta_real: st.conferencia[GAVETA_CX[c]] ?? null });
        CX_SUJO = false;
        FLASH = status === 'fechado' ? `Caixa do ${c.toLowerCase()} de ${dm(data)} fechado.` : `Rascunho do ${c.toLowerCase()} salvo.`;
        atualizarBadgeAfazeres(); render();
      } catch (err) { alert(err.message); }
    };
    v.querySelectorAll('[data-salvarcanal]').forEach(b => b.onclick = () => gravarCanal(b.dataset.salvarcanal, 'rascunho'));
    v.querySelectorAll('[data-fecharcanal]').forEach(b => b.onclick = () => {
      const c = b.dataset.fecharcanal, st = coletar(v);
      const tot = calcCaixa(st.canais).canais[c].total;
      const semReal = st.conferencia[GAVETA_CX[c]] == null;
      if (!confirm(`Fechar o caixa do ${c.toLowerCase()} de ${dm(data)} com total de ${money(tot)}?${semReal ? '\n\nAtenção: o valor real da gaveta não foi preenchido na conferência.' : ''}\n\nDepois de fechado, só o administrador consegue reabrir.`)) return;
      gravarCanal(c, 'fechado');
    });
    v.querySelectorAll('[data-reabrircanal]').forEach(b => b.onclick = async () => {
      const c = b.dataset.reabrircanal;
      if (!confirm(`Reabrir o caixa do ${c.toLowerCase()} de ${dm(data)}? Fica registrado no histórico.`)) return;
      try { await send('POST', `fin/caixa/dia/${data}/canal/${encodeURIComponent(c)}/reabrir`); FLASH = `Caixa do ${c.toLowerCase()} reaberto.`; render(); }
      catch (err) { alert(err.message); }
    });
    v.querySelector('#naoabriu')?.addEventListener('click', () => {
      const motivo = prompt('Motivo de não ter aberto (ex.: feriado, reforma):', r.planilha_nao_abriu || '');
      if (motivo && motivo.trim()) gravar('nao_abriu', { motivo: motivo.trim(), canais: {}, conferencia: {} });
    });
    v.addEventListener('click', async e => {   // admin: PIX feito / pagamento posterior feito
      const b = e.target.closest('[data-pago]');
      if (!b) return;
      const [canal, linha, pago] = b.dataset.pago.split('|');
      try {
        await send('POST', `fin/caixa/dia/${data}/equipe/${encodeURIComponent(canal)}/${linha}/pago`, { pago: pago === '1' });
        FLASH = pago === '1' ? 'Pagamento marcado como feito.' : 'Pagamento voltou para "não pago".';
        atualizarBadgeAfazeres(); render();
      } catch (ex) { alert(ex.message); }
    });
    v.querySelector('#conferir')?.addEventListener('click', async () => {
      const conf = Object.fromEntries(CFG_CX.itens.map(i => {
        const inp = v.querySelector(`[data-real="${i.item}"]`); return [i.item, inp && inp.value !== '' ? nz(inp.value) : null];
      }));
      const falta = Object.values(conf).filter(x => x == null).length;
      if (falta && !confirm(`${falta} item(ns) da conferência sem valor real. Marcar como conferido mesmo assim?`)) return;
      await send('POST', `fin/caixa/dia/${data}/conferir`, { conferencia: conf });
      FLASH = `Fechamento de ${dm(data)} conferido.`; atualizarBadgeAfazeres(); render();
    });
    v.querySelector('#reabrir')?.addEventListener('click', async () => {
      if (!confirm('Reabrir este dia para edição? Fica registrado no histórico.')) return;
      await send('POST', `fin/caixa/dia/${data}/reabrir`);
      FLASH = 'Dia reaberto para edição.'; render();
    });
    v.querySelector('#copiar')?.addEventListener('click', () => {
      if (!confirm('Preencher o formulário com os valores da planilha deste dia? O que estiver digitado será substituído.')) return;
      CANAIS_CX.forEach(c => {
        const pp = r.planilha.canais[c]; if (!pp) return;
        const card = v.querySelector(`[data-canal="${c}"]`);
        if (card.dataset.trav) return;   // canal já fechado não muda
        const set = (k, val) => { const i = card.querySelector(`[data-k="${k}"]`); i.value = i.classList.contains('money') ? fmtMoeda(val ?? '') : (val ?? ''); };
        definirResp(card.querySelector('[data-k="responsavel"]'), pp.responsavel); set('troco_inicial', pp.troco_inicial); set('diversos', pp.diversos || '');
        set('fechamento_dinheiro', pp.fechamento_dinheiro); set('observacao', pp.observacao);
        card.querySelectorAll('[data-forma]').forEach(i => { i.value = fmtMoeda(pp.formas[i.dataset.forma] || ''); });
        card.querySelector(`[data-equipe="${c}"]`).innerHTML = pp.equipe.map(e => linhaEquipe(c, e)).join('');
      });
      Object.entries(r.planilha.conferencia).forEach(([it, x]) => {
        const inp = v.querySelector(`[data-real="${it}"]`); if (inp && !inp.disabled) inp.value = fmtMoeda(x.valor_real ?? '');
      });
      sujar(); atualizar();
    });
    atualizar();
  },
};

// ---------------------------------------------------------------- fechamento → fluxo de caixa (admin)
// Servidor: caixa_fluxo.py. Modo teste: só guarda e compara com o Nibo, sem entrar no fluxo.
async function painelFluxoCaixa(box, data) {
  let r;
  try { r = await api(`fin/fluxo-caixa/${data}`); } catch (e) { box.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; return; }
  const trava = r.confirmado ? 'disabled' : '';
  const opConta = sel => `<option value="">— Conta —</option>${r.opcoes.contas.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.conta)}</option>`).join('')}`;
  const opCat = (tipo, sel) => {
    const grupos = {};
    r.opcoes.categorias.filter(c => c.tipo === tipo).forEach(c => (grupos[c.grupo || 'Outras'] ||= []).push(c));
    return `<option value="">— Categoria —</option>${Object.entries(grupos).map(([g, cs]) => `<optgroup label="${esc(g)}">${cs.map(c =>
      `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.categoria)}</option>`).join('')}</optgroup>`).join('')}`;
  };
  const nibo = l => !l.nibo ? '<span class="muted">não achei no Nibo</span>'
    : l.nibo.igual ? `<span class="ok-txt">✓ igual</span><small>${esc(l.nibo.descricao || '')}</small>`
    : `<span class="neg">≠ ${money(l.nibo.valor)}</span><small>${esc(l.nibo.descricao || '')} · ${dm(l.nibo.data)}</small>`;
  const linha = (l, i) => {
    const rec = l.tipo === 'receber';
    return `<tr data-i="${i}" class="${rec ? 'fx-rec' : 'fx-pag'}">
      <td class="fx-desc"><span class="fx-tipo">${rec ? 'Receber' : 'Pagar'}</span>
        <input data-f="descricao" value="${esc(l.descricao)}" maxlength="300" ${trava}>
        <small>${esc(l.detalhe || '')}${l.contato ? ` · ${esc(l.contato)}` : ''}</small></td>
      <td class="n"><input class="money" data-f="valor" inputmode="decimal" value="${fmtMoeda(l.valor)}" ${trava}></td>
      <td class="fx-sit"><select data-f="quitado" ${trava}><option value="1" ${l.quitado ? 'selected' : ''}>${rec ? 'Recebido' : 'Pago'}</option>
        <option value="0" ${l.quitado ? '' : 'selected'}>${rec ? 'A receber' : 'A pagar'}</option></select>
        <input type="date" data-f="vencimento" value="${l.vencimento}" ${trava} title="${l.quitado ? 'Data em que entrou/saiu' : 'Data prevista'}"></td>
      <td class="fx-cc"><select data-f="conta_id" ${trava}>${opConta(l.conta_id)}</select>
        <select data-f="categoria_id" ${trava}>${opCat(l.tipo, l.categoria_id)}</select></td>
      <td class="fx-nibo">${nibo(l)}</td></tr>`;
  };
  const rec = r.linhas.filter(l => l.tipo === 'receber'), pag = r.linhas.filter(l => l.tipo === 'pagar');
  const soma = ls => ls.reduce((s, l) => s + Number(l.valor), 0);
  box.innerHTML = `<div class="fx-head"><div><h3>Lançar no fluxo de caixa</h3>
      <div class="sub">${r.teste ? '<b>Modo teste:</b> ao confirmar, fica guardado e comparado com o Nibo — <b>não entra no fluxo</b> (você continua lançando no Nibo).'
        : 'Ao confirmar, os lançamentos entram em contas recebidas / a receber / pagas.'}</div></div>
      <label class="check-l fx-modo"><input type="checkbox" id="fx-teste" ${r.teste ? 'checked' : ''}> Modo teste</label></div>
    ${!r.linhas.length ? '<p class="muted">Nada a lançar neste dia.</p>' : `
    <div class="table-wrap"><table class="fx-tab"><thead><tr><th>Lançamento</th><th class="n">Valor</th><th>Situação e data</th><th>Conta e categoria</th><th>No Nibo</th></tr></thead>
      <tbody>${r.linhas.map(linha).join('')}</tbody></table></div>
    <div class="fx-tot"><span>Recebimentos <b class="ok-txt">${money(soma(rec))}</b></span><span>Pagamentos <b class="neg">${money(soma(pag))}</b></span></div>`}
    <div class="dlg-err" hidden></div>
    <div class="fx-acoes">${r.confirmado
      ? `<span class="muted small-txt">✓ Confirmado${r.confirmado_por ? ` por ${esc(r.confirmado_por)}` : ''} em ${new Date(r.confirmado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${r.lancado ? ' · está no fluxo de caixa' : r.teste ? ' · modo teste (não está no fluxo)' : ' · ainda não está no fluxo'}</span>
         <button class="btn" id="fx-refazer">${r.lancado ? 'Desfazer lançamento' : 'Editar de novo'}</button>
         ${!r.lancado && !r.teste ? '<button class="btn primary" id="fx-lancar">Lançar no fluxo agora</button>' : ''}`
      : r.linhas.length ? `<button class="btn primary" id="fx-ok">${r.teste ? 'Confirmar e comparar com o Nibo' : 'Confirmar e lançar no fluxo'}</button>` : ''}</div>`;
  const err = box.querySelector('.dlg-err');
  const falha = ex => { err.hidden = false; err.textContent = ex.message; };
  const coletar = () => [...box.querySelectorAll('tbody tr')].map(tr => {
    const l = r.linhas[tr.dataset.i], g = f => tr.querySelector(`[data-f="${f}"]`).value;
    return { chave: l.chave, tipo: l.tipo, contato: l.contato, descricao: g('descricao').trim(), valor: lerMoeda(g('valor')),
             quitado: g('quitado') === '1', vencimento: g('vencimento'), conta_id: g('conta_id') || null, categoria_id: g('categoria_id') || null };
  });
  box.querySelector('#fx-teste').onchange = async e => {
    const t = e.target.checked;
    if (!t && !confirm('Desligar o modo teste? A partir daí, confirmar LANÇA no fluxo de caixa — pare de lançar esses valores no Nibo para não contar em dobro.')) { e.target.checked = true; return; }
    try { await send('PUT', 'fin/fluxo-caixa/modo/teste', { teste: t }); painelFluxoCaixa(box, data); } catch (ex) { e.target.checked = !t; falha(ex); }
  };
  box.querySelector('#fx-ok')?.addEventListener('click', async () => {
    try { await send('POST', `fin/fluxo-caixa/${data}`, { linhas: coletar() }); painelFluxoCaixa(box, data); } catch (ex) { falha(ex); }
  });
  box.querySelector('#fx-lancar')?.addEventListener('click', async () => {   // confirmado em teste, agora lança de verdade
    try {
      await send('DELETE', `fin/fluxo-caixa/${data}`);
      await send('POST', `fin/fluxo-caixa/${data}`, { linhas: r.linhas.map(l => ({ chave: l.chave, tipo: l.tipo, contato: l.contato, descricao: l.descricao,
        valor: Number(l.valor), quitado: l.quitado, vencimento: l.vencimento, conta_id: l.conta_id, categoria_id: l.categoria_id })) });
      painelFluxoCaixa(box, data);
    } catch (ex) { falha(ex); painelFluxoCaixa(box, data); }
  });
  box.querySelector('#fx-refazer')?.addEventListener('click', async () => {
    if (r.lancado && !confirm('Desfazer? Os lançamentos deste dia saem do fluxo de caixa (ficam como cancelados no histórico).')) return;
    try { await send('DELETE', `fin/fluxo-caixa/${data}`); painelFluxoCaixa(box, data); } catch (ex) { falha(ex); }
  });
}
