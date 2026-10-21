// Cadastros › Cardápio e estoque: uma tela só, em cartões, para produtos finais, insumos manufaturados e insumos.
// Clicar num cartão abre o painel lateral com os dados, os preços e a ficha técnica juntos (um único Salvar).
// Usa os ajudantes da ficha técnica de cadastros.js (converterUn, lerQtd, fmtQtd, corCmv, pct1).

const TIPOS_CE = {
  produto: { rot: 'Produtos', um: 'produto', novo: 'Novo produto' },
  manufaturado: { rot: 'Manufaturados', um: 'insumo manufaturado', novo: 'Novo manufaturado' },
  insumo: { rot: 'Insumos', um: 'insumo', novo: 'Novo insumo' },
};
// Unidade de saída do insumo: como ele é medido na ficha técnica.
// custo de unidade pequena (ml, grama...) com 4 casas para não virar "R$ 0,05"
const moneyFino = v => v == null || isNaN(v) ? '—' : Math.abs(v) < 1 && v !== 0
  ? `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : money(v);
// Unidade de saída: as mesmas unidades da compra (cadastros.UNIDADES) + kg cozido e limpo + porções
const SAIDA = { compra: 'Igual à unidade de compra',
  ...Object.fromEntries(UNIDADES),
  limpo: 'Kg cozido e limpo', porcoes: 'Porções (em unidade)' };
const ROT_UN_SAIDA = { limpo: 'kg limpo', porcoes: 'porção', ...Object.fromEntries(UNIDADES.map(([k]) => [k, k])) };
const rotSaida = i => i.tipo === 'manufaturado' ? i.unidade : (ROT_UN_SAIDA[i.saida_tipo] || i.unidade);
// texto "Rende ..." de cada tipo de saída
const PLURAL_UN = { kg: 'kg', g: 'gramas', l: 'litros', ml: 'ml', un: 'unidades', cx: 'caixas', pct: 'pacotes', dz: 'dúzias', fardo: 'fardos', m: 'metros' };
const RENDE_SAIDA = { limpo: 'Peso depois de limpo e cozido (kg)', porcoes: 'Rende quantas porções',
  ...Object.fromEntries(UNIDADES.map(([k]) => [k, `Quanto rende (${PLURAL_UN[k] || k})`])) };
const aproveita = (base, rende) => base > 0 && rende > 0 ? Math.round(rende / base * 100) : null;
const normBusca = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const numOuNulo = v => { const n = lerQtd(v); return String(v ?? '').trim() === '' || isNaN(n) ? null : n; };

async function abaCardapioEstoque(box, p, tipo) {
  let dados = await api('fichas/catalogo');
  const st = { tipo, cat: p.cat || '', q: p.q || '', arq: p.arq === '1' };
  const ABA_DO = { insumo: 'insumos', manufaturado: 'manufaturados', produto: 'produtos' };
  const urlEstado = (extra = {}) => `#/cadastros?${new URLSearchParams(Object.fromEntries(Object.entries(
    { aba: ABA_DO[st.tipo], cat: st.cat, q: st.q, arq: st.arq ? '1' : '', ...extra }).filter(([, v]) => v)))}`;
  const lembrar = extra => history.replaceState(null, '', urlEstado(extra));   // muda a URL sem recarregar a tela

  const itensDo = tipo => tipo === 'produto' ? dados.produtos : dados.insumos.filter(i => i.tipo === tipo);
  box.innerHTML = `
    <div id="ce-flash"></div>
    <div class="ce-barra">
      <select id="ce-cat" aria-label="Categoria"></select>
      <label class="ce-busca"><span aria-hidden="true">⌕</span><input type="search" id="ce-q" placeholder="Buscar pelo nome…" value="${esc(st.q)}" autocomplete="off"></label>
      <label class="check-l ce-arq"><input type="checkbox" id="ce-arq" ${st.arq ? 'checked' : ''}> Mostrar arquivados</label>
      <button type="button" class="btn" id="ce-cats">Categorias</button>
      <button type="button" class="btn primary" id="ce-novo"></button>
    </div>
    <div id="ce-grade"></div>`;

  const cartao = (tipo, x) => {
    const arq = x.ativo ? '' : '<span class="ce-tag">arquivado</span>';
    if (tipo === 'produto') {
      const aviso = !x.itens ? '<span class="ce-aviso">sem ficha técnica</span>' : !x.preco_venda ? '<span class="ce-aviso">sem preço</span>' : '';
      return `<button type="button" class="ce-card" data-abrir="produto:${x.id}" data-busca="${esc(normBusca(x.nome))}">
        <b>${esc(x.nome)}</b>${arq}
        <span class="ce-preco">${x.preco_venda ? money(x.preco_venda) : '—'}${x.preco_app ? `<small> · app ${money(x.preco_app)}</small>` : ''}</span>
        <span class="ce-rod">${x.cmv_pct != null ? `<span class="cmv-badge ${corCmv(x.cmv_pct)}">CMV ${pct1(x.cmv_pct)}</span>` : ''}${aviso}
          ${x.itens && x.custo_total ? `<small>custo ${money(x.custo_total)}</small>` : ''}</span></button>`;
    }
    const usos = x.usado_em.length;
    const usoTxt = usos ? `usado em ${usos} ${usos === 1 ? 'ficha' : 'fichas'}` : 'não usado em fichas';
    if (tipo === 'manufaturado') return `<button type="button" class="ce-card" data-abrir="manufaturado:${x.id}" data-busca="${esc(normBusca(x.nome))}">
        <b>${esc(x.nome)}</b>${arq}
        <span class="ce-preco">${x.custo_efetivo != null ? `${money(x.custo_efetivo)}<small> / ${x.unidade}</small>` : '—'}</span>
        <span class="ce-rod">${x.itens ? `<small>receita com ${x.itens} itens · rende ${fmtQtd(Number(x.rendimento))} ${x.unidade}</small>` : '<span class="ce-aviso">sem receita</span>'}
          <small>${usoTxt}</small></span></button>`;
    const base = Number(x.saida_base), rende = Number(x.saida_rende);
    const como = x.saida_tipo === 'limpo' ? `${fmtQtd(base)} ${x.unidade} rende ${fmtQtd(rende)} kg limpo${x.unidade === 'kg' ? ` (${aproveita(base, rende)}%)` : ''}`
      : x.saida_tipo === 'porcoes' ? `${fmtQtd(base)} ${x.unidade} = ${fmtQtd(rende)} porções`
      : x.saida_tipo && x.saida_tipo !== 'compra' ? `${fmtQtd(base)} ${x.unidade} = ${fmtQtd(rende)} ${x.saida_tipo}` : '';
    return `<button type="button" class="ce-card" data-abrir="insumo:${x.id}" data-busca="${esc(normBusca(x.nome))}">
        <b>${esc(x.nome)}</b>${arq}
        <span class="ce-preco">${x.custo_efetivo != null ? `${moneyFino(x.custo_efetivo)}<small> / ${rotSaida(x)}</small>` : '<span class="ce-aviso">sem preço</span>'}</span>
        <span class="ce-rod">${como && x.custo_unitario != null ? `<small>compra ${money(x.custo_unitario)}/${x.unidade} · ${como}</small>` : ''}
          <small>${usoTxt}</small></span></button>`;
  };

  function desenhar() {
    const t = TIPOS_CE[st.tipo];
    box.querySelector('#ce-novo').textContent = `＋ ${t.novo}`;
    box.querySelector('#ce-cats').hidden = st.tipo === 'manufaturado';
    const todos = itensDo(st.tipo).filter(x => st.arq || x.ativo);
    const grupoDe = x => st.tipo === 'manufaturado' ? 'Insumos manufaturados' : (x.categoria || 'Sem categoria');
    const grupos = {};
    todos.forEach(x => (grupos[grupoDe(x)] ||= []).push(x));
    if (st.cat && !grupos[st.cat]) st.cat = '';
    const selCat = box.querySelector('#ce-cat');   // categoria numa caixa de seleção (manufaturados não têm categoria)
    selCat.hidden = st.tipo === 'manufaturado';
    selCat.innerHTML = `<option value="">Todas as categorias (${todos.length})</option>` +
      Object.entries(grupos).map(([g, xs]) => `<option value="${esc(g)}" ${st.cat === g ? 'selected' : ''}>${esc(g)} (${xs.length})</option>`).join('');
    box.querySelector('#ce-grade').innerHTML = Object.entries(grupos).filter(([g]) => !st.cat || g === st.cat).map(([g, xs]) =>
      `<section class="ce-grupo"><h4>${esc(g)}</h4><div class="ce-cards">${xs.map(x => cartao(st.tipo, x)).join('')}</div></section>`).join('')
      || `<div class="card empty">Nenhum ${t.um} cadastrado ainda.</div>`;
    filtrar();
  }
  function filtrar() {   // busca instantânea: esconde cartões e grupos vazios sem redesenhar
    const termo = normBusca(st.q.trim());
    box.querySelectorAll('.ce-grupo').forEach(sec => {
      let vis = 0;
      sec.querySelectorAll('.ce-card').forEach(c => { const ok = !termo || c.dataset.busca.includes(termo); c.hidden = !ok; vis += ok; });
      sec.hidden = !vis;
    });
    const vazio = box.querySelector('#ce-vazio');
    const nada = termo && ![...box.querySelectorAll('.ce-card')].some(c => !c.hidden);
    if (nada && !vazio) box.querySelector('#ce-grade').insertAdjacentHTML('beforeend', `<div class="card empty" id="ce-vazio">Nada encontrado para “${esc(st.q)}”.</div>`);
    if (!nada && vazio) vazio.remove();
  }

  box.querySelector('#ce-cat').onchange = e => { st.cat = e.target.value; lembrar(); desenhar(); };
  box.querySelector('#ce-q').oninput = e => { st.q = e.target.value; lembrar(); filtrar(); };
  box.querySelector('#ce-arq').onchange = e => { st.arq = e.target.checked; lembrar(); desenhar(); };
  box.querySelector('#ce-cats').onclick = () => gerenciarCategorias(st.tipo === 'produto' ? 'produto' : 'insumo');
  box.querySelector('#ce-novo').onclick = () => abrirItem(st.tipo, null);
  box.querySelector('#ce-grade').onclick = e => {
    const c = e.target.closest('[data-abrir]');
    if (c) { const [t, id] = c.dataset.abrir.split(':'); abrirItem(t, id); }
  };

  async function recarregar(msg) {
    dados = await api('fichas/catalogo');
    FIN_OPCOES = null;
    desenhar();
    box.querySelector('#ce-flash').innerHTML = msg ? `<div class="alert ok">${esc(msg)}</div>` : '';
  }

  async function abrirItem(tipo, id) {
    const item = id ? (tipo === 'produto' ? dados.produtos : dados.insumos).find(x => x.id === id) : null;
    if (id && !item) return;
    lembrar(id ? { item: `${tipo}:${id}` } : {});
    await painelItem({ tipo, item, dados, aoSalvar: recarregar, aoAbrirOutro: abrirItem, aoFechar: () => lembrar() });
  }

  desenhar();
  if (p.item) { const [tipo, id] = p.item.split(':'); if (TIPOS_CE[tipo]) abrirItem(tipo, id); }
}

// ---------------------------------------------------------------- painel lateral do item
async function painelItem({ tipo, item, dados, aoSalvar, aoAbrirOutro, aoFechar }) {
  const produto = tipo === 'produto', manuf = tipo === 'manufaturado', insumo = tipo === 'insumo';
  const novo = !item;
  let idSalvo = item?.id || null;   // depois do 1º gravar, um novo item passa a ser editado (evita duplicar se a ficha falhar)
  const x = item || { nome: '', ativo: true, canais: ['Salão', 'Delivery'], unidade: 'kg', saida_tipo: 'compra', rendimento: produto ? 1 : null };
  const ficha = !insumo && !novo ? await api(`fichas/${tipo}/${x.id}`) : { linhas: [] };
  if (insumo) await finOpcoes();
  const catsDo = g => dados.categorias.filter(c => c.grupo === g);
  const opt = (lista, sel) => lista.map(([v, r]) => `<option value="${esc(v)}" ${String(sel ?? '') === String(v) ? 'selected' : ''}>${esc(r)}</option>`).join('');
  const optCat = g => opt([['', '— Sem categoria —'], ...catsDo(g).map(c => [c.id, c.nome])], x.categoria_id);

  // insumos que podem entrar na ficha (o próprio manufaturado fica de fora)
  const disponiveis = dados.insumos.filter(i => i.ativo && i.id !== x.id);
  const porId = Object.fromEntries(disponiveis.map(i => [i.id, i]));
  const gruposIns = {};
  disponiveis.forEach(i => (gruposIns[i.tipo === 'manufaturado' ? 'Manufaturados' : (i.categoria || 'Insumos sem categoria')] ||= []).push(i));
  const opIns = sel => `<option value="">Escolha o insumo…</option>` + Object.entries(gruposIns).map(([g, is]) =>
    `<optgroup label="${esc(g)}">${is.map(i => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.nome)} (${rotSaida(i)})</option>`).join('')}</optgroup>`).join('');
  const opUn = (insId, sel) => (porId[insId]?.compativeis || [sel || 'un']).map(u => `<option ${u === sel ? 'selected' : ''}>${u}</option>`).join('');
  const linha = (l = {}) => `<tr data-linha>
    <td><select data-ins>${opIns(l.insumo_id)}</select></td>
    <td class="n"><input data-qtd inputmode="decimal" value="${fmtQtd(l.quantidade)}" placeholder="0"></td>
    <td><select data-un>${opUn(l.insumo_id, l.unidade)}</select></td>
    <td class="n"><input data-perda inputmode="decimal" value="${l.perda_pct ? fmtQtd(l.perda_pct) : ''}" placeholder="0"></td>
    <td class="n" data-custo></td>
    <td><button type="button" class="ico-btn" data-rm aria-label="Remover">×</button></td></tr>`;

  // fornecedor padrão: só fornecedores de insumos (Cadastros › Pessoas); mantém o atual mesmo se for de outro grupo
  const fornecedores = insumo ? FIN_OPCOES.pessoas.filter(f => f.papeis.includes('fornecedor')
    && (f.tipo_fornecedor === 'insumos' || f.id === x.fornecedor_id)) : [];
  const campos = produto ? `
      <label class="span2">Nome do produto *<input name="nome" required maxlength="120" value="${esc(x.nome)}" placeholder="Ex.: X-Bacon artesanal"></label>
      <label>Categoria<select name="categoria_id">${optCat('produto')}</select></label>
      <label>A receita rende (porções)<input name="rendimento" inputmode="decimal" value="${fmtQtd(Number(x.rendimento ?? 1))}"></label>
      <label>Preço no salão (R$)<input name="preco_venda" class="money" inputmode="decimal" value="${fmtMoeda(x.preco_venda)}" placeholder="0,00"></label>
      <label>Preço no app de delivery (R$)<input name="preco_app" class="money" inputmode="decimal" value="${fmtMoeda(x.preco_app)}" placeholder="0,00"></label>`
    : manuf ? `
      <label class="span2">Nome do manufaturado *<input name="nome" required maxlength="120" value="${esc(x.nome)}" placeholder="Ex.: Maionese da casa"></label>
      <label>Unidade<select name="unidade">${opt(UNIDADES, x.unidade)}</select></label>
      <label>A receita rende (na unidade)<input name="rendimento" inputmode="decimal" value="${x.rendimento != null ? fmtQtd(Number(x.rendimento)) : ''}" placeholder="Ex.: 3"></label>`
    : `
      <label class="span2">Nome do insumo *<input name="nome" required maxlength="120" value="${esc(x.nome)}" placeholder="Ex.: Tomate italiano"></label>
      <label>Categoria<select name="categoria_id">${optCat('insumo')}</select></label>
      <label>Unidade de compra<select name="unidade">${opt(UNIDADES, x.unidade)}</select></label>
      <label>Preço de compra por unidade (R$)<input name="custo_unitario" class="money" inputmode="decimal" value="${fmtMoeda(x.custo_unitario)}" placeholder="0,00"></label>
      <label class="span2">Unidade de saída <small>como o insumo é medido na ficha técnica</small>
        <select name="saida_tipo">${opt(Object.entries(SAIDA), x.saida_tipo || 'compra')}</select></label>
      <div class="span2 ce-saida" data-saida-box>
        <label><span data-rot-base></span><input name="saida_base" inputmode="decimal" value="${x.saida_base != null ? fmtQtd(Number(x.saida_base)) : '1'}"></label>
        <label><span data-rot-rende></span><input name="saida_rende" inputmode="decimal" value="${x.saida_rende != null ? fmtQtd(Number(x.saida_rende)) : ''}" placeholder="0"></label>
        <p class="ce-saida-res" data-saida-res></p>
      </div>
      ${x.usado_em?.length ? `<p class="span2 ce-saida-aviso" data-saida-aviso hidden>Atenção: ${x.usado_em.length} ficha(s) usam este insumo em
        <b>${esc(rotSaida(x))}</b>. Mudando a unidade de saída, revise as quantidades nessas fichas.</p>` : ''}
      <label class="span2">Fornecedor padrão<select name="fornecedor_id">${opt([['', '— Nenhum —'], ...fornecedores.map(f => [f.id, f.nome])], x.fornecedor_id)}</select></label>`;
  const usos = insumo || manuf ? (x.usado_em || []) : [];
  const usadoEm = (insumo || manuf) && !novo ? `<div class="span2 ce-usos"><h4>Usado em</h4>${usos.length
    ? usos.map(u => `<button type="button" class="chip" data-outro="${u.tipo}:${u.id}">${esc(u.nome)}</button>`).join('')
    : '<span class="muted small-txt">Ainda não aparece em nenhuma ficha técnica.</span>'}</div>` : '';
  const fichaHtml = insumo ? '' : `<div class="span2 ce-ficha">
      <h4>${produto ? 'Ficha técnica' : 'Receita'} <small>${produto ? 'quanto de cada insumo vai na receita' : 'ingredientes de uma receita'}</small></h4>
      <div class="table-wrap"><table class="ficha-tab"><thead><tr><th>Insumo</th><th class="n">Qtd.</th><th>Unid.</th><th class="n">Perda %</th><th class="n">Custo</th><th></th></tr></thead>
        <tbody id="linhas">${ficha.linhas.map(linha).join('')}</tbody></table></div>
      <button type="button" class="btn sm" id="add-linha">＋ Adicionar insumo</button>
      <label class="ce-preparo">Modo de preparo <small>aparece na ficha de produção da equipe (sem custos)</small>
        <textarea name="modo_preparo" rows="5" maxlength="8000" placeholder="1. Separe os ingredientes…&#10;2. …&#10;Montagem / apresentação, tempo, ponto, validade…">${esc(ficha.dono?.modo_preparo || '')}</textarea></label></div>`;
  const mais = produto ? `
      <label>Código no PDV / cardápio<input name="codigo_pdv" maxlength="40" value="${esc(x.codigo_pdv || '')}"></label>
      <fieldset class="checks"><legend>Vendido no</legend>${['Salão', 'Delivery'].map(c =>
        `<label><input type="checkbox" name="canais" value="${c}" ${(x.canais || []).includes(c) ? 'checked' : ''}> ${c}</label>`).join('')}</fieldset>
      <label class="span2">Descrição<textarea name="descricao" rows="2" maxlength="500">${esc(x.descricao || '')}</textarea></label>`
    : `${manuf ? `<label>Custo manual por ${x.unidade} (R$)<input name="custo_unitario" class="money" inputmode="decimal" value="${fmtMoeda(x.custo_unitario)}" placeholder="0,00">
          <small>Só é usado se não houver receita.</small></label>` : ''}
      <label>Estoque mínimo (na unidade)<input name="estoque_minimo" inputmode="decimal" value="${x.estoque_minimo != null ? fmtQtd(Number(x.estoque_minimo)) : ''}"></label>
      <label>Código interno<input name="codigo" maxlength="40" value="${esc(x.codigo || '')}"></label>
      <label class="span2">Observações<textarea name="observacao" rows="2" maxlength="500">${esc(x.observacao || '')}</textarea></label>`;

  let dr = document.getElementById('drawer');
  if (!dr) { dr = document.createElement('dialog'); dr.id = 'drawer'; document.body.appendChild(dr); }
  dr.className = 'drawer drawer-largo';
  dr.innerHTML = `<form class="drawer-body" autocomplete="off" novalidate>
    <div class="drawer-head"><div><div class="eyebrow">${novo ? TIPOS_CE[tipo].novo : (produto ? 'Produto final' : manuf ? 'Insumo manufaturado' : 'Insumo')}</div>
      <h3>${novo ? 'Preencha os dados' : esc(x.nome)}${x.ativo === false ? ' <span class="ce-tag">arquivado</span>' : ''}</h3></div><button type="button" class="btn sm" data-fechar aria-label="Fechar">✕</button></div>
    <div class="drawer-campos">
      ${campos}${fichaHtml}${usadoEm}
      <details class="span2 ce-mais"><summary>Mais informações</summary><div class="ce-mais-grid">${mais}</div></details>
    </div>
    <div class="dlg-err" hidden></div>
    <div class="drawer-foot">
      <div class="ce-kpis">${produto ? `<div><small>Custo por porção</small><b id="k-custo"></b></div><div><small>CMV salão</small><b id="k-cmv"></b></div>
          <div><small>Margem salão</small><b id="k-margem"></b></div>`
        : manuf ? '<div><small>Custo da receita</small><b id="k-custo"></b></div><div><small>Custo por unidade</small><b id="k-cmv"></b></div>'
        : '<div><small>Custo final por unidade</small><b id="k-custo"></b></div>'}</div>
      <div class="actions"><span class="muted small-txt" id="sujo"></span>
        ${novo ? '' : `<button type="button" class="btn ${x.ativo === false ? '' : 'perigo'}" data-arquivar>${x.ativo === false ? 'Reativar' : 'Arquivar'}</button>`}
        <button type="button" class="btn" data-fechar>Cancelar</button>
        <button type="submit" class="btn primary">Salvar</button></div>
    </div></form>`;
  const f = dr.querySelector('form'), tb = dr.querySelector('#linhas');
  const val = n => f.elements[n]?.value ?? '';
  let sujo = false;
  let ativo = x.ativo !== false, msgSalvo = '';   // Arquivar/Reativar troca o ativo e salva junto com o resto

  const recalc = () => {
    if (insumo) {
      const c = lerMoeda(val('custo_unitario')), tipoS = val('saida_tipo'), un = val('unidade');
      const base = lerQtd(val('saida_base')), rende = lerQtd(val('saida_rende'));
      const unSaida = ROT_UN_SAIDA[tipoS] || un;
      const box = dr.querySelector('[data-saida-box]');
      box.hidden = tipoS === 'compra';
      dr.querySelector('[data-rot-base]').textContent = `Quantidade comprada (${un})`;
      dr.querySelector('[data-rot-rende]').textContent = RENDE_SAIDA[tipoS] || '';
      const aviso = dr.querySelector('[data-saida-aviso]');
      if (aviso) aviso.hidden = unSaida === rotSaida(x);
      const ok = tipoS === 'compra' || (base > 0 && rende > 0);
      const custo = isNaN(c) || !ok ? null : tipoS === 'compra' ? c : c * base / rende;
      const res = dr.querySelector('[data-saida-res]');
      res.innerHTML = !ok ? 'Preencha as duas quantidades para calcular o custo.'
        : tipoS === 'limpo' ? `${fmtQtd(base)} ${un} comprado${base === 1 ? '' : 's'} rende${base === 1 ? '' : 'm'} ${fmtQtd(rende)} kg limpo${un === 'kg' ? ` — aproveitamento de <b>${aproveita(base, rende)}%</b> (perda de ${100 - aproveita(base, rende)}%)` : ''}.`
        : tipoS === 'porcoes' ? `${fmtQtd(base)} ${un} vira${base === 1 ? '' : 'm'} ${fmtQtd(rende)} porções — ${fmtQtd(Math.round(base / rende * 1000) / 1000)} ${un} por porção.`
        : `${fmtQtd(base)} ${un} = ${fmtQtd(rende)} ${unSaida} — a ficha técnica usa o insumo em ${unSaida}.`;
      dr.querySelector('#k-custo').textContent = custo == null ? '—' : `${moneyFino(custo)} / ${unSaida}`;
      return;
    }
    let total = 0, faltando = false;
    tb.querySelectorAll('[data-linha]').forEach(tr => {
      const ins = porId[tr.querySelector('[data-ins]').value];
      const qtd = lerQtd(tr.querySelector('[data-qtd]').value), perda = lerQtd(tr.querySelector('[data-perda]').value) || 0;
      const conv = ins ? converterUn(qtd, tr.querySelector('[data-un]').value, ins.unidade_saida) : null;
      const cu = ins?.custo_efetivo;
      const cel = tr.querySelector('[data-custo]');
      if (ins && qtd > 0 && conv != null && cu != null) { const c = conv * cu * (1 + perda / 100); total += c; cel.textContent = money(c); }
      else { cel.textContent = ins && qtd > 0 ? 'sem custo' : ''; if (ins && qtd > 0) faltando = true; }
    });
    const rend = lerQtd(val('rendimento'));
    if (produto) {
      const porcao = rend > 0 ? total / rend : total, preco = lerMoeda(val('preco_venda'));
      const cmv = preco > 0 ? porcao / preco * 100 : null;
      dr.querySelector('#k-custo').textContent = money(porcao) + (faltando ? ' *' : '');
      const k = dr.querySelector('#k-cmv'); k.textContent = pct1(cmv); k.className = corCmv(cmv);
      dr.querySelector('#k-margem').textContent = preco > 0 ? money(preco - porcao) : '—';
    } else {
      dr.querySelector('#k-custo').textContent = money(total) + (faltando ? ' *' : '');
      dr.querySelector('#k-cmv').textContent = rend > 0 ? `${money(total / rend)} / ${val('unidade')}` : 'informe o rendimento';
    }
  };
  const marcar = () => { sujo = true; dr.querySelector('#sujo').textContent = 'Alterações não salvas'; recalc(); };
  f.addEventListener('input', marcar);
  f.addEventListener('change', e => {
    const sel = e.target.closest('[data-ins]');
    if (sel) {   // trocou o insumo: oferece só as unidades compatíveis (kg → começa em g, l → ml)
      const ins = porId[sel.value];
      const u = ins?.unidade_saida;
      sel.closest('tr').querySelector('[data-un]').innerHTML = opUn(sel.value, u === 'kg' ? 'g' : u === 'l' ? 'ml' : u);
    }
    marcar();
  });
  const fechar = () => { if (!sujo || confirm('Descartar as alterações não salvas?')) dr.close(); };
  dr.onclick = e => {
    if (e.target.closest('[data-fechar]')) fechar();
    else if (e.target.closest('[data-rm]')) { e.target.closest('tr').remove(); marcar(); }
    else if (e.target.closest('[data-arquivar]')) {
      const usos = (x.usado_em || []).length;
      const aviso = ativo ? `Arquivar "${x.nome}"? Ele sai das listas${produto ? ', da engenharia e da precificação' : ''}${usos ? ` e não aparece para novas fichas (as ${usos} fichas que já o usam continuam iguais)` : ''}. Dá para reativar depois em "Mostrar arquivados".`
        : `Reativar "${x.nome}"?`;
      if (!confirm(aviso)) return;
      ativo = !ativo; msgSalvo = `${x.nome} ${ativo ? 'reativado' : 'arquivado'}.`;
      f.requestSubmit();
    }
    else if (e.target.closest('#add-linha')) { tb.insertAdjacentHTML('beforeend', linha()); tb.lastElementChild.querySelector('[data-ins]').focus(); }
    else if (e.target.closest('[data-outro]')) {
      if (sujo && !confirm('Descartar as alterações não salvas?')) return;
      const [t, i] = e.target.closest('[data-outro]').dataset.outro.split(':');
      sujo = false; dr.onclose = null; dr.close(); aoAbrirOutro(t, i);   // sem limpar a URL do item que vai abrir
    }
  };
  dr.oncancel = e => { e.preventDefault(); fechar(); };   // tecla Esc
  dr.onclose = () => aoFechar();

  f.onsubmit = async e => {
    e.preventDefault();
    const err = dr.querySelector('.dlg-err'); err.hidden = true;
    const btn = f.querySelector('[type=submit]');
    try {
      if (!val('nome').trim()) throw new Error('Informe o nome.');
      const moeda = n => { const v = val(n).trim(); return v === '' ? null : lerMoeda(v); };
      const itens = insumo ? [] : [...tb.querySelectorAll('[data-linha]')].map(tr => ({
        insumo_id: tr.querySelector('[data-ins]').value, quantidade: lerQtd(tr.querySelector('[data-qtd]').value),
        unidade: tr.querySelector('[data-un]').value, perda_pct: lerQtd(tr.querySelector('[data-perda]').value) || 0,
      })).filter(i => i.insumo_id || i.quantidade);
      if (itens.some(i => !i.insumo_id || !(i.quantidade > 0))) throw new Error('Cada linha da ficha precisa de insumo e quantidade maior que zero.');
      const rendimento = numOuNulo(val('rendimento'));
      if (produto && !(rendimento > 0)) throw new Error('A receita precisa render pelo menos 1 porção.');
      const comum = { nome: val('nome').trim(), ativo };
      const corpo = produto ? { ...comum, categoria_id: val('categoria_id') || null, preco_venda: moeda('preco_venda'), preco_app: moeda('preco_app'),
          codigo_pdv: val('codigo_pdv').trim() || null, descricao: val('descricao').trim() || null,
          canais: [...f.querySelectorAll('[name=canais]:checked')].map(c => c.value) }
        : { ...comum, tipo, categoria_id: insumo ? (val('categoria_id') || null) : null, unidade: val('unidade'),
            custo_unitario: moeda('custo_unitario'), saida_tipo: insumo ? val('saida_tipo') : 'compra',
            saida_base: insumo && val('saida_tipo') !== 'compra' ? numOuNulo(val('saida_base')) : null,
            saida_rende: insumo && val('saida_tipo') !== 'compra' ? numOuNulo(val('saida_rende')) : null,
            rendimento: manuf ? rendimento : null, estoque_minimo: numOuNulo(val('estoque_minimo')),
            fornecedor_id: insumo ? (val('fornecedor_id') || null) : null, codigo: val('codigo').trim() || null, observacao: val('observacao').trim() || null };
      btn.disabled = true; btn.textContent = 'Salvando…';
      const rota = produto ? 'cad/produtos' : 'cad/insumos';
      const salvo = idSalvo ? await send('PUT', `${rota}/${idSalvo}`, corpo) : await send('POST', rota, corpo);
      idSalvo = salvo.id;
      let alerta = '';
      if (!insumo) {
        const r = await send('PUT', `fichas/${tipo}/${salvo.id}`, { itens, ...(rendimento > 0 ? { rendimento } : {}), modo_preparo: val('modo_preparo') });
        alerta = r.alerta || '';
      }
      sujo = false; dr.close();
      await aoSalvar(alerta || msgSalvo || `${comum.nome} salvo.`);
    } catch (ex) {
      if (msgSalvo) { ativo = !ativo; msgSalvo = ''; }   // não arquivou: volta ao estado anterior
      err.hidden = false; err.textContent = ex.message;
      btn.disabled = false; btn.textContent = 'Salvar';
    }
  };
  if (!insumo && !ficha.linhas.length) tb.insertAdjacentHTML('beforeend', linha());
  recalc();
  if (!dr.open) dr.showModal();
  if (novo) f.elements.nome.focus();
}
