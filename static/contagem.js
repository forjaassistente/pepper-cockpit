// Estoque: contagem (cega, pensada para o celular), estoque atual, histórico e configuração da contagem.
// Quem tem habilitação de estoque (salão/cozinha) vê só a contagem; o admin vê tudo. Servidor: estoque.py.

const SETOR_ROT = { salao: 'Salão', cozinha: 'Cozinha' };
// Agenda (estoque.py): domingo = contagem para compras; quinta = 2ª contagem dos itens de giro rápido;
// último dia do mês = todos os itens (inventário para conciliação e CMV)
const FREQ_ROT = { '2x_semana': 'Domingo e quinta', semanal: 'Todo domingo', quinzenal: 'Domingo, a cada 15 dias', mensal: 'Só no fim do mês' };
const DIA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const diaRot = d => { const dt = parseD(d), hoje = parseD(hojeIso()), dif = Math.round((dt - hoje) / 86400000);
  return dif === 0 ? 'hoje' : dif === 1 ? 'amanhã' : `${DIA_SEMANA[dt.getDay()]} ${dm(d)}`; };
const podeContar = () => USUARIO?.perfil === 'admin' || (USUARIO?.estoque_setores || []).length > 0;
const fmtN = n => n == null ? '—' : fmtQtd(Number(n));
const quandoCurto = s => { const d = new Date(s); return `${dm(iso(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---------------------------------------------------------------- contagem: escolher o setor
async function abaContagem(box, p) {
  if (p.id) return telaContagem(box, p.id, p.ordem);
  const r = await api('portal/estoque');
  box.innerHTML = `
    ${r.inventario ? `<div class="alert warn"><b>Hoje é o inventário do mês.</b> Todos os itens entram na contagem — ela fecha o estoque
      para a conciliação e o cálculo do CMV.</div>` : ''}
    <p class="sub" style="margin:0 0 12px">A lista traz só o que precisa ser contado hoje: domingo é a contagem para as compras,
      quinta a segunda contagem dos itens de giro rápido e, no último dia do mês, todos os itens.
      Conte o que está na prateleira e digite a quantidade — cada item é salvo na hora.</p>
    <div class="ct-setores">${r.setores.map(s => `<div class="card ct-setor">
      <div class="eyebrow">${SETOR_ROT[s.setor]}</div>
      ${s.aberta ? `<h3>Contagem em andamento</h3>
          <p class="sub">${s.aberta.contados} de ${s.aberta.total} itens contados · começou ${quandoCurto(s.aberta.iniciada_em)}${s.aberta.usuario_nome ? ` por ${esc(s.aberta.usuario_nome)}` : ''}</p>
          <div class="ct-barra"><span style="width:${s.aberta.total ? s.aberta.contados / s.aberta.total * 100 : 0}%"></span></div>
          <a class="btn primary" href="#/estoque?aba=contagem&id=${s.aberta.id}">Continuar contagem</a>`
        : `<h3>${s.devidos ? `${s.devidos} ${s.devidos === 1 ? 'item' : 'itens'} para contar hoje` : 'Nada para contar hoje'}</h3>
          <p class="sub">${s.ultima ? `Última contagem: ${quandoCurto(s.ultima)}` : 'Nenhuma contagem ainda'} · ${s.configurados} itens configurados
            ${!s.devidos && s.proxima ? `<br>Próxima contagem: <b>${diaRot(s.proxima)}</b>` : ''}</p>
          ${s.devidos ? `<button class="btn primary" data-iniciar="${s.setor}">Começar contagem</button>` : ''}
          ${s.configurados ? `<button class="link-btn" data-todos="${s.setor}">Contar todos os ${s.configurados} itens do setor</button>` : ''}`}
      ${s.configurados ? `<button class="btn sm ct-imprimir" data-folha="${s.setor}">🖨 Imprimir folha para contar à mão</button>` : ''}
      ${!s.configurados && !s.aberta ? `<p class="muted small-txt">Nenhum item configurado para este setor${USUARIO.perfil === 'admin' ? ' — veja “Configurar contagem”.' : '.'}</p>` : ''}
    </div>`).join('')}</div>
    <div class="dlg-err" id="ct-err" hidden></div>`;
  box.onclick = async e => {
    const fo = e.target.closest('[data-folha]');
    if (fo) return dialogoFolha(fo.dataset.folha, r.hoje);
    const b = e.target.closest('[data-iniciar],[data-todos]');
    if (!b) return;
    const setor = b.dataset.iniciar || b.dataset.todos;
    try {
      const c = await send('POST', `portal/estoque/${setor}/iniciar${b.dataset.todos ? '?todos=true' : ''}`);
      location.hash = `#/estoque?aba=contagem&id=${c.id}`;
    } catch (ex) { const err = box.querySelector('#ct-err'); err.hidden = false; err.textContent = ex.message; }
  };
}

// ---------------------------------------------------------------- folha impressa (contagem à mão, depois digitada no app)
function dialogoFolha(setor, hoje) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-body">
    <h3>Folha de contagem — ${SETOR_ROT[setor]}</h3>
    <p class="sub">Uma página por estoque, com espaço para escrever a quantidade. Depois é só digitar no app.</p>
    <label>Dia da contagem<input type="date" name="data" value="${hoje}"></label>
    <label class="check-l"><input type="radio" name="quais" value="dia" checked> Só os itens que vencem nesse dia</label>
    <label class="check-l"><input type="radio" name="quais" value="todos"> Todos os itens do setor</label>
    <div class="dlg-err" hidden></div>
    <div class="actions"><button value="cancel" class="btn">Cancelar</button><button value="ok" class="btn primary">Imprimir</button></div></form>`;
  const f = dlg.querySelector('form');
  f.onsubmit = async e => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      const todos = f.quais.value === 'todos';
      const r = await api(`portal/estoque/${setor}/folha?${new URLSearchParams({ data: f.data.value || hoje, ...(todos ? { todos: 'true' } : {}) })}`);
      if (!r.itens.length) throw new Error('Nenhum item vence nesse dia. Escolha “Todos os itens do setor” para imprimir a lista completa.');
      dlg.close();
      imprimirFolha(r);
    } catch (ex) { const err = dlg.querySelector('.dlg-err'); err.hidden = false; err.textContent = ex.message; }
  };
  dlg.showModal();
}

function imprimirFolha(r) {
  const locais = {};
  r.itens.forEach(i => ((locais[i.local] ||= {})[i.categoria] ||= []).push(i));
  const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const d = parseD(r.data);
  const titulo = `Contagem de estoque — ${SETOR_ROT[r.setor]} — ${dm(r.data)}`;
  const corpo = Object.entries(locais).map(([local, cats], n) => `<section class="${n ? 'quebra' : ''}">
    <div class="p-cab">__LOGO__<div><h1>Contagem de estoque · ${esc(local)}</h1>
      <small>${esc(nomeEmpresa())} · ${SETOR_ROT[r.setor]} · ${DIAS[d.getDay()]}, ${dm(r.data)}/${r.data.slice(0, 4)}${r.inventario ? ' · <b>inventário do mês</b>' : ''}${r.todos ? ' · todos os itens' : ''}</small></div></div>
    <div class="p-campos"><span>Contado por:</span><span>Hora:</span><span>Conferido por:</span></div>
    ${Object.entries(cats).map(([cat, itens]) => `<h3>${esc(cat)}</h3>
      <table><thead><tr><th>Item</th><th>Unid.</th><th class="caixa">Quantidade</th><th class="obs">Obs.</th></tr></thead><tbody>
      ${itens.map(i => `<tr><td>${esc(i.nome)}</td><td>${esc(i.unidade)}</td><td class="caixa"></td><td class="obs"></td></tr>`).join('')}
      </tbody></table>`).join('')}
    <p class="p-rod">Conte o que está na prateleira, na unidade indicada (ex.: 2,5 kg; 12 un). Depois digite no app em Estoque › Contagem.</p>
  </section>`).join('');
  imprimirDoc(titulo, corpo);
}

// ---------------------------------------------------------------- contagem: a lista
async function telaContagem(box, cid, ordemInicial) {
  const c = await api(`portal/estoque/contagem/${cid}`);
  let ordem = ordemInicial === 'categoria' ? 'categoria' : 'local';
  const itens = c.itens;
  const progresso = () => {
    const n = itens.filter(i => i.quantidade != null).length;
    box.querySelector('#ct-prog').textContent = `${n} de ${itens.length} contados`;
    box.querySelector('#ct-bar').style.width = `${itens.length ? n / itens.length * 100 : 0}%`;
  };
  const chave = i => `${i.insumo_id}|${i.central_id || ''}`;
  const centraisDo = id => itens.filter(x => x.insumo_id === id).length;
  const linha = i => `<label class="ct-item ${i.quantidade != null ? 'ok' : ''}" data-k="${chave(i)}" data-busca="${esc(normBusca(i.nome))}">
      <span class="ct-nome">${esc(i.nome)}${ordem === 'categoria' && centraisDo(i.insumo_id) > 1 ? ` <small>· ${esc(i.local)}</small>` : ''}${i.previsto ? '' : ' <small>(fora da lista)</small>'}</span>
      <span class="ct-qtd"><input inputmode="decimal" autocomplete="off" value="${fmtN(i.quantidade) === '—' ? '' : fmtN(i.quantidade)}" placeholder="—"
        aria-label="Quantidade de ${esc(i.nome)} em ${i.unidade}"><span class="ct-un">${i.unidade}</span><span class="ct-st" aria-hidden="true"></span></span></label>`;
  const desenharLista = () => {
    const grupos = {}, ordemGrupo = {};
    itens.forEach(i => { (grupos[i[ordem]] ||= []).push(i); ordemGrupo[i[ordem]] = ordem === 'local' ? i.local_ordem : 0; });
    box.querySelector('#ct-lista').innerHTML = Object.keys(grupos).sort((a, b) => (ordemGrupo[a] - ordemGrupo[b]) || a.localeCompare(b, 'pt-BR')).map(g =>
      `<section class="ct-grupo"><h4>${esc(g)}</h4>${grupos[g].map(linha).join('')}</section>`).join('');
    filtrar();
  };
  const filtrar = () => {
    const t = normBusca(box.querySelector('#ct-q').value.trim());
    box.querySelectorAll('.ct-grupo').forEach(sec => {
      let vis = 0;
      sec.querySelectorAll('.ct-item').forEach(el => { const ok = !t || el.dataset.busca.includes(t); el.hidden = !ok; vis += ok; });
      sec.hidden = !vis;
    });
  };
  box.innerHTML = `
    <div class="ct-topo card">
      <div class="graf-head"><div><div class="eyebrow">${c.inventario ? 'Inventário do mês' : 'Contagem'} · ${SETOR_ROT[c.setor]}</div>
        <h3 style="margin:2px 0 0">Começou ${quandoCurto(c.iniciada_em)}${c.usuario_nome ? ` · ${esc(c.usuario_nome)}` : ''}</h3></div>
        <a class="btn sm" href="#/estoque?aba=contagem">Voltar</a></div>
      <div class="ct-barra"><span id="ct-bar"></span></div>
      <div class="ct-ctrl"><span class="muted small-txt" id="ct-prog"></span>
        <div class="chips"><button type="button" class="chip" data-ordem="local">Por central</button><button type="button" class="chip" data-ordem="categoria">Por categoria</button></div></div>
      <input type="search" id="ct-q" class="ct-busca" placeholder="Buscar item…" autocomplete="off">
    </div>
    <div id="ct-lista"></div>
    ${c.extras.length ? `<div class="card ct-add"><label>Contar um item que não está na lista
      <select id="ct-extra"><option value="">Escolha…</option>${c.extras.map(x => `<option value="${chave(x)}">${esc(x.nome)} (${x.unidade}) · ${esc(x.local)}</option>`).join('')}</select></label></div>` : ''}
    <div class="ct-rodape"><div class="dlg-err" id="ct-err" hidden></div><button class="btn primary" id="ct-fim">Finalizar contagem</button></div>`;
  const marcarOrdem = () => box.querySelectorAll('[data-ordem]').forEach(b => b.classList.toggle('on', b.dataset.ordem === ordem));
  box.querySelectorAll('[data-ordem]').forEach(b => b.onclick = () => {
    ordem = b.dataset.ordem; marcarOrdem(); desenharLista();
    history.replaceState(null, '', `#/estoque?aba=contagem&id=${cid}&ordem=${ordem}`);
  });
  box.querySelector('#ct-q').oninput = filtrar;

  // salva cada item quando a pessoa sai do campo (ou aperta Enter, que pula para o próximo)
  const salvar = async el => {
    const row = el.closest('.ct-item'), i = itens.find(x => chave(x) === row.dataset.k);
    const txt = el.value.trim(), q = txt === '' ? null : lerQtd(txt);
    if (q != null && (isNaN(q) || q < 0)) { row.className = 'ct-item erro'; row.querySelector('.ct-st').title = 'Número inválido'; return; }
    if ((q ?? null) === (i.quantidade == null ? null : Number(i.quantidade))) return;
    row.className = 'ct-item salvando';
    try {
      await send('PUT', `portal/estoque/contagem/${cid}/itens/${i.insumo_id}${i.central_id ? `?central=${i.central_id}` : ''}`, { quantidade: q });
      i.quantidade = q; row.className = `ct-item ${q != null ? 'ok' : ''}`;
      if (q != null) el.value = fmtN(q);
      progresso();
    } catch (ex) { row.className = 'ct-item erro'; row.querySelector('.ct-st').title = ex.message; }
  };
  box.addEventListener('focusout', e => { if (e.target.closest('.ct-qtd input')) salvar(e.target); });
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.closest('.ct-qtd input')) return;
    e.preventDefault();
    const todos = [...box.querySelectorAll('.ct-item:not([hidden]) .ct-qtd input')];
    const prox = todos[todos.indexOf(e.target) + 1];
    if (prox) prox.focus(); else e.target.blur();
  });
  const extra = box.querySelector('#ct-extra');
  if (extra) extra.onchange = () => {
    const x = c.extras.find(z => chave(z) === extra.value);
    if (!x) return;
    itens.push({ insumo_id: x.insumo_id, central_id: x.central_id, nome: x.nome, unidade: x.unidade, quantidade: null, previsto: false,
                 local: x.local, local_ordem: x.local_ordem, categoria: 'Fora da lista' });
    extra.querySelector(`option[value="${chave(x)}"]`).remove(); extra.value = '';
    desenharLista(); progresso();
    box.querySelector(`.ct-item[data-k="${chave(x)}"] input`).focus();
  };
  box.querySelector('#ct-fim').onclick = async () => {
    const err = box.querySelector('#ct-err'); err.hidden = true;
    if (document.activeElement?.closest?.('.ct-qtd')) await salvar(document.activeElement);
    const faltam = itens.filter(i => i.previsto && i.quantidade == null).length;
    if (faltam && !confirm(`Faltam ${faltam} ${faltam === 1 ? 'item' : 'itens'} da lista. Finalizar mesmo assim? Eles voltam na próxima contagem.`)) return;
    try {
      const r = await send('POST', `portal/estoque/contagem/${cid}/finalizar`);
      FLASH = `Contagem finalizada: ${r.contados} ${r.contados === 1 ? 'item contado' : 'itens contados'}${r.faltaram ? `, ${r.faltaram} ficaram para a próxima` : ''}. Obrigado!`;
      location.hash = '#/estoque?aba=contagem';
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
  };
  marcarOrdem(); desenharLista(); progresso();
}

// ---------------------------------------------------------------- estoque atual (admin)
async function abaEstoqueAtual(box, p) {
  const todos = await api('estoque/atual');
  const setor = SETOR_ROT[p.setor] ? p.setor : '';
  const nomesCentrais = [...new Set(todos.flatMap(x => x.centrais))];
  const central = nomesCentrais.includes(p.central) ? p.central : '';
  const lista = todos.filter(x => (!setor || x.contagem_setor === setor) && (!central || x.centrais.includes(central)));
  const hoje = hojeIso();
  const valor = lista.reduce((s, x) => s + (x.valor || 0), 0);
  const abaixo = lista.filter(x => x.abaixo_minimo).length;
  const atrasados = lista.filter(x => x.atrasada).length;
  const grupos = {};
  lista.forEach(x => (grupos[x.categoria] ||= []).push(x));
  const link = mud => `#/estoque?${new URLSearchParams({ aba: 'atual', setor, central, ...mud })}`;
  box.innerHTML = `
    <div class="grid g3 eng-kpis">
      ${kpi('Valor em estoque', money(valor), 'última contagem + entradas das notas')}
      ${kpi('Abaixo do mínimo', abaixo, abaixo ? 'veja os itens marcados em vermelho' : 'tudo acima do mínimo')}
      ${kpi('Contagens atrasadas', atrasados, 'itens que já passaram da data de contar')}
    </div>
    <div class="card filters"><div class="filter-row">
      <label>Setor<select id="ea-setor"><option value="">Salão e cozinha</option>${Object.entries(SETOR_ROT).map(([k, r]) =>
        `<option value="${k}" ${k === setor ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label>Central<select id="ea-central"><option value="">Todas as centrais</option>${nomesCentrais.map(n =>
        `<option ${n === central ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    </div></div>
    ${lista.length ? Object.keys(grupos).map(g => `<div class="card"><h3>${esc(g)}</h3>
      ${table([
        { t: 'Item', f: x => `<b>${esc(x.nome)}</b>${x.contagem_setor ? ` <small class="muted">· ${SETOR_ROT[x.contagem_setor]}</small>` : ''}` },
        { t: 'Em estoque', n: 1, f: x => x.estoque != null ? `<span class="${x.abaixo_minimo ? 'neg' : ''}">${fmtN(x.estoque)} ${x.unidade}</span>`
            : `<span class="muted">nunca contado</span>${Number(x.entradas) ? `<br><small class="muted">+${fmtN(x.entradas)} ${x.unidade} em notas</small>` : ''}` },
        { t: 'Na contagem', f: x => x.por_central?.length ? `<small class="muted">${x.por_central.map(pc => `${esc(pc.central)} ${fmtN(pc.quantidade)}`).join(' · ')}${Number(x.entradas)
            ? ` <br>+ ${fmtN(x.entradas)} em notas depois` : ''}</small>` : x.centrais.length ? `<small class="muted">${x.centrais.map(esc).join(' · ')}</small>` : '—' },
        { t: 'Mínimo', n: 1, f: x => x.estoque_minimo != null ? `${fmtN(x.estoque_minimo)} ${x.unidade}` : '—' },
        { t: 'Valor', n: 1, f: x => x.valor != null ? money(x.valor) : '—' },
        { t: 'Contado em', f: x => x.contado_em ? quandoCurto(x.contado_em) : '—' },
        { t: 'Próxima contagem', f: x => !x.contagem_freq ? '<span class="muted">não conta</span>'
            : x.atrasada ? '<span class="cand-st st-nao_recomendado">atrasada</span>'
            : x.proxima <= hoje ? '<span class="cand-st st-contratado">hoje</span>'
            : `${diaRot(x.proxima)} <small class="muted">· ${FREQ_ROT[x.contagem_freq].toLowerCase()}</small>` },
      ], grupos[g])}</div>`).join('')
      : '<div class="card empty">Nenhum item configurado para contagem ainda. Comece em “Configurar contagem”.</div>'}`;
  box.querySelector('#ea-setor').onchange = e => { location.hash = link({ setor: e.target.value }); };
  box.querySelector('#ea-central').onchange = e => { location.hash = link({ central: e.target.value }); };
}

// ---------------------------------------------------------------- histórico (admin)
async function abaHistoricoContagem(box) {
  const lista = await api('estoque/contagens');
  box.innerHTML = `<div class="card">${table([
    { t: 'Quando', f: c => `<button class="link-nome" data-ver="${c.id}">${quandoCurto(c.iniciada_em)}</button>` },
    { t: 'Setor', f: c => `${SETOR_ROT[c.setor]}${c.inventario ? ' <span class="cand-st st-contratado">inventário do mês</span>' : ''}` },
    { t: 'Quem contou', f: c => esc(c.usuario_nome || '—') },
    { t: 'Itens contados', n: 1, f: c => c.contados }, { t: 'Ficaram para depois', n: 1, f: c => c.faltaram || '—' },
    { t: 'Situação', f: c => c.status === 'aberta' ? '<span class="cand-st st-contratado">em andamento</span>' : `finalizada ${quandoCurto(c.finalizada_em)}` },
    { t: '', f: c => c.status === 'aberta' ? `<button class="btn sm perigo" data-cancelar="${c.id}">Cancelar</button>` : '' },
  ], lista)}${lista.length ? '' : '<p class="muted">Nenhuma contagem ainda.</p>'}</div>`;
  box.onclick = async e => {
    const ver = e.target.closest('[data-ver]'), canc = e.target.closest('[data-cancelar]');
    if (canc) {
      if (!confirm('Cancelar esta contagem em andamento? O que já foi digitado nela será descartado.')) return;
      try { await send('DELETE', `estoque/contagens/${canc.dataset.cancelar}`); FLASH = 'Contagem cancelada.'; render(); }
      catch (ex) { alert(ex.message); }
    }
    if (ver) detalheContagem(ver.dataset.ver);
  };
}

async function detalheContagem(id) {
  const dlg = document.getElementById('dlg');
  dlg.className = 'dlg xl';
  dlg.addEventListener('close', () => { dlg.className = 'dlg'; }, { once: true });
  dlg.innerHTML = '<div class="dlg-body"><div class="loading">Carregando…</div></div>';
  dlg.showModal();
  const r = await api(`estoque/contagens/${id}`);
  const c = r.contagem;
  dlg.innerHTML = `<div class="dlg-body">
    <div class="hist-head"><div><h3>Contagem · ${SETOR_ROT[c.setor]}</h3>
      <div class="sub">${quandoCurto(c.iniciada_em)}${c.usuario_nome ? ` · ${esc(c.usuario_nome)}` : ''} · ${c.status === 'aberta' ? 'em andamento' : `finalizada ${quandoCurto(c.finalizada_em)}`}</div></div>
      <form method="dialog"><button class="btn sm">Fechar</button></form></div>
    <p class="sub">Consumo = contagem anterior + entradas das notas no período − esta contagem (o que saiu: vendas, perdas e desvios).
      Fica negativo quando faltou conciliar alguma nota do período.</p>
    ${table([
      { t: 'Item', f: x => `${esc(x.nome)}${x.previsto ? '' : ' <small class="muted">(fora da lista)</small>'}` },
      { t: 'Centrais', f: x => `<small class="muted">${(x.por_central || []).map(pc => `${esc(pc.central)} ${pc.quantidade != null ? fmtN(pc.quantidade) : '—'}`).join(' · ')}</small>` },
      { t: 'Anterior', n: 1, f: x => x.anterior != null ? `${fmtN(x.anterior)} ${x.unidade}` : '—' },
      { t: 'Contado', n: 1, f: x => x.quantidade != null ? `<b>${fmtN(x.quantidade)} ${x.unidade}</b>` : '<span class="muted">não contado</span>' },
      { t: 'Entradas', n: 1, f: x => Number(x.entradas) ? `+${fmtN(x.entradas)} ${x.unidade}` : '—' },
      { t: 'Consumo', n: 1, f: x => x.anterior != null && x.quantidade != null ? `${fmtN(Math.round((Number(x.anterior) + Number(x.entradas) - x.quantidade) * 1000) / 1000)} ${x.unidade}` : '—' },
      { t: 'Valor do consumo', n: 1, f: x => x.anterior != null && x.quantidade != null && x.custo_unitario != null && x.tipo === 'insumo'
          ? money((Number(x.anterior) + Number(x.entradas) - x.quantidade) * x.custo_unitario) : '—' },
    ], r.itens)}</div>`;
}

// ---------------------------------------------------------------- configurar contagem (admin)
async function abaConfigContagem(box, p) {
  const r = await api('estoque/config');
  const todos = r.itens, centrais = r.centrais;
  const cats = [...new Set(todos.map(x => x.categoria))];
  const cat = cats.includes(p.cat) ? p.cat : '';
  const lista = todos.filter(x => !cat || x.categoria === cat);
  const opt = (obj, sel, vazio) => `<option value="">${vazio}</option>` + Object.entries(obj).map(([k, rot]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${rot}</option>`).join('');
  const caixas = (sel, attr) => centrais.map(c => `<label class="cc-cent"><input type="checkbox" ${attr} value="${c.id}" ${sel.includes(c.id) ? 'checked' : ''}> ${esc(c.nome)}</label>`).join('');
  const grupos = {};
  lista.forEach(x => (grupos[x.categoria] ||= []).push(x));
  box.innerHTML = `
    <div class="cad-head"><p class="sub">Defina o que é contado, quando, por qual setor e em quais <b>centrais de estoque</b> o item fica
      (pode marcar mais de uma — ele é contado em cada central). A contagem para compras é no domingo (e na quinta para “Domingo e quinta”);
      no <b>último dia do mês todos os itens configurados são contados</b> (inventário para conciliação e CMV).</p>
      <a class="btn" href="#/cadastros?aba=centrais">Centrais de estoque</a></div>
    ${centrais.length ? '' : '<div class="alert warn">Nenhuma central de estoque cadastrada. Cadastre em Cadastros › Centrais de estoque.</div>'}
    <div class="card filters"><div class="filter-row">
      <label>Categoria<select id="cc-cat"><option value="">Todas as categorias (${todos.length})</option>${cats.map(c =>
        `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <div class="cc-massa"><span>Aplicar a todos os itens visíveis:</span>
        <select id="cc-m-freq">${opt(FREQ_ROT, '', '— Frequência —')}<option value="nao">Não conta</option></select>
        <select id="cc-m-setor">${opt(SETOR_ROT, '', '— Setor —')}</select>
        <span class="cc-cents">${caixas([], 'data-m-cent')}</span>
        <select id="cc-m-modo"><option value="add">acrescentar centrais</option><option value="set">substituir centrais</option></select>
        <button type="button" class="btn sm" id="cc-aplicar">Aplicar</button></div>
    </div></div>
    ${Object.entries(grupos).map(([g, xs]) => `<div class="card"><h3>${esc(g)}</h3><div class="table-wrap"><table class="cc-tab">
      <thead><tr><th>Item</th><th>Unid.</th><th>Frequência</th><th>Setor</th><th>Centrais de estoque</th></tr></thead><tbody>
      ${xs.map(x => `<tr data-id="${x.id}"><td>${esc(x.nome)}</td><td>${x.unidade}</td>
        <td><select data-k="contagem_freq">${opt(FREQ_ROT, x.contagem_freq, 'Não conta')}</select></td>
        <td><select data-k="contagem_setor">${opt(SETOR_ROT, x.contagem_setor, '—')}</select></td>
        <td><div class="cc-cents">${caixas(x.centrais, 'data-cent')}</div></td></tr>`).join('')}
      </tbody></table></div></div>`).join('')}
    <div class="ct-rodape"><span class="muted small-txt" id="cc-sujo"></span><div class="dlg-err" id="cc-err" hidden></div>
      <button class="btn primary" id="cc-salvar">Salvar configuração</button></div>`;
  const mudados = new Set();
  const sujar = tr => { mudados.add(tr.dataset.id); box.querySelector('#cc-sujo').textContent = `${mudados.size} item(ns) alterado(s), não salvos`; };
  box.addEventListener('change', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    // escolheu frequência sem setor: sugere o setor mais comum entre os itens já configurados
    if (e.target.dataset.k === 'contagem_freq' && e.target.value && !tr.querySelector('[data-k=contagem_setor]').value) {
      const usado = [...box.querySelectorAll('[data-k=contagem_setor]')].map(x => x.value).filter(Boolean);
      tr.querySelector('[data-k=contagem_setor]').value = usado.filter(v => v === 'salao').length > usado.length / 2 ? 'salao' : 'cozinha';
    }
    sujar(tr);
  });
  box.querySelector('#cc-cat').onchange = e => {
    if (mudados.size && !confirm('Há alterações não salvas. Trocar de categoria e descartar?')) { e.target.value = cat; return; }
    location.hash = `#/estoque?aba=config${e.target.value ? `&cat=${encodeURIComponent(e.target.value)}` : ''}`;
  };
  box.querySelector('#cc-aplicar').onclick = () => {
    const f = box.querySelector('#cc-m-freq').value, s = box.querySelector('#cc-m-setor').value;
    const cents = [...box.querySelectorAll('[data-m-cent]:checked')].map(i => i.value), modo = box.querySelector('#cc-m-modo').value;
    if (!f && !s && !cents.length && modo !== 'set') return;
    box.querySelectorAll('tr[data-id]').forEach(tr => {
      if (f) tr.querySelector('[data-k=contagem_freq]').value = f === 'nao' ? '' : f;
      if (s) tr.querySelector('[data-k=contagem_setor]').value = s;
      if (cents.length || modo === 'set') tr.querySelectorAll('[data-cent]').forEach(i => {
        if (modo === 'set') i.checked = cents.includes(i.value); else if (cents.includes(i.value)) i.checked = true;
      });
      sujar(tr);
    });
  };
  box.querySelector('#cc-salvar').onclick = async () => {
    const err = box.querySelector('#cc-err'); err.hidden = true;
    const itens = [...box.querySelectorAll('tr[data-id]')].filter(tr => mudados.has(tr.dataset.id)).map(tr => ({
      id: tr.dataset.id, contagem_freq: tr.querySelector('[data-k=contagem_freq]').value || null,
      contagem_setor: tr.querySelector('[data-k=contagem_setor]').value || null,
      centrais: [...tr.querySelectorAll('[data-cent]:checked')].map(i => i.value) }));
    if (!itens.length) { err.hidden = false; err.textContent = 'Nada mudou.'; return; }
    const semSetor = itens.filter(i => i.contagem_freq && !i.contagem_setor).length;
    if (semSetor) { err.hidden = false; err.textContent = `${semSetor} item(ns) com frequência mas sem setor. Escolha salão ou cozinha.`; return; }
    const semCentral = itens.filter(i => i.contagem_freq && !i.centrais.length).length;
    if (semCentral && !confirm(`${semCentral} item(ns) contados sem nenhuma central marcada. Salvar assim mesmo?`)) return;
    try { const x = await send('PUT', 'estoque/config', { itens }); FLASH = `Configuração salva (${x.gravados} item(ns)).`; render(); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; }
  };
}

// ---------------------------------------------------------------- cadastro das centrais de estoque (Cadastros › Cardápio e estoque)
async function abaCentrais(box) {
  const lista = await api('estoque/centrais');
  const campos = [{ k: 'nome', rot: 'Nome da central *', req: true, span: true, max: 60, ph: 'Ex.: Estoque Grande, Câmara fria, Bar' },
                  { k: 'ordem', rot: 'Ordem na contagem', tipo: 'number', step: '1', padrao: 100, ajuda: 'A lista da contagem segue esta ordem (o caminho de quem conta).' },
                  { k: 'ativo', rot: 'Central ativa (desmarque para arquivar)', tipo: 'bool' }];
  box.innerHTML = `
    <div class="cad-head"><p class="sub">Os lugares onde o estoque fica guardado. Cada item pode estar em uma ou mais centrais
      (escolha em Estoque › Configurar contagem); na contagem ele é contado em cada uma.</p>
      <button class="btn primary" data-novo>＋ Nova central</button></div>
    <div class="card">${table([
      { t: 'Central', f: c => `<b>${esc(c.nome)}</b>` }, { t: 'Ordem', n: 1, f: c => c.ordem },
      { t: 'Itens', n: 1, f: c => c.itens }, { t: 'Situação', f: c => situacao(c.ativo) },
      { t: '', f: (c, i) => `<button class="btn sm" data-edit="${c.id}">Editar</button>` },
    ], lista)}${lista.length ? '' : '<p class="muted">Nenhuma central cadastrada.</p>'}
    <p class="muted small-txt"><a href="#/estoque?aba=config">Escolher em quais centrais cada item fica →</a></p></div>`;
  box.querySelector('[data-novo]').onclick = () => dialogoCad({ titulo: 'Nova central de estoque', campos,
    valores: { ordem: (Math.max(0, ...lista.map(c => c.ordem)) + 10) }, salvar: d => send('POST', 'estoque/centrais', d) });
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const c = lista.find(x => x.id === b.dataset.edit);
    dialogoCad({ titulo: `Editar ${c.nome}`, campos, valores: c, salvar: d => send('PUT', `estoque/centrais/${c.id}`, d),
      nota: c.itens ? `${c.itens} item(ns) ficam nesta central. Arquivando, ela sai das listas de contagem.` : '' });
  });
}

// ---------------------------------------------------------------- página
const ABA_ESTOQUE = { contagem: abaContagem, atual: abaEstoqueAtual, historico: abaHistoricoContagem, config: abaConfigContagem };
PAGES['estoque'] = {
  eyebrow: 'Estoque', title: 'Estoque', lede: 'Contagem, estoque atual e configuração da contagem.', periodo: false,
  async render(v, p) {
    const aba = USUARIO.perfil !== 'admin' ? 'contagem' : ABA_ESTOQUE[p.aba] ? p.aba : 'contagem';
    document.getElementById('title').textContent = { contagem: 'Contagem de estoque', atual: 'Estoque atual', historico: 'Histórico de contagens', config: 'Configurar contagem' }[aba];
    if (USUARIO.perfil !== 'admin') document.getElementById('lede').textContent = 'Conte o que está na prateleira e digite a quantidade.';
    const flash = FLASH; FLASH = '';
    v.innerHTML = `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}<section id="est-box" class="view"></section>`;
    await ABA_ESTOQUE[aba](v.querySelector('#est-box'), p);
  },
};
