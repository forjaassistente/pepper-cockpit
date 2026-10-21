// Módulo financeiro: contas a pagar/receber, lançamento e fluxo projetado.
// Usa os utilitários do app.js (money, kpi, bars, line, api, send…). Títulos do Nibo são só leitura.

let FIN_OPCOES = null;
let FLASH = '';
const finOpcoes = async () => (FIN_OPCOES ||= await api('fin/opcoes'));
const hojeIso = () => iso(new Date());
const fimDoMes = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const NOME_TIPO = { pagar: 'A pagar', receber: 'A receber' };
const VERBO = { pagar: 'Pagar', receber: 'Receber' };

function addMonths(isoStr, n) {
  if (!isoStr) return null;
  const d = parseD(isoStr);
  const alvo = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const ultimo = fimDoMes(alvo).getDate();
  return iso(new Date(alvo.getFullYear(), alvo.getMonth(), Math.min(d.getDate(), ultimo)));
}

function categoriaOptions(tipo, selecionada, vazia = 'Selecione…') {
  const grupos = {};
  FIN_OPCOES.categorias.filter(c => !tipo || c.tipo === tipo).forEach(c => {
    const g = c.subgrupo ? `${c.grupo} › ${c.subgrupo}` : c.grupo;
    (grupos[g] ||= []).push(c);
  });
  return `<option value="">${vazia}</option>` + Object.entries(grupos).map(([g, cs]) =>
    `<optgroup label="${esc(g)}">${cs.map(c => `<option value="${c.id}" ${c.id === selecionada ? 'selected' : ''}>${esc(c.categoria)}</option>`).join('')}</optgroup>`).join('');
}

const contaOptions = sel => '<option value="">Selecione…</option>' + FIN_OPCOES.contas.map(c =>
  `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.conta)} · saldo ${money(c.saldo_atual)}</option>`).join('');

const badge = origem => `<span class="badge ${origem}">${origem === 'nibo' ? 'Nibo' : 'Manual'}</span>`;

// ---------------------------------------------------------------- seletor de fornecedor/cliente (só do cadastro)
const PAPEL_CURTO = { fornecedor: 'Fornecedor', cliente: 'Cliente', funcionario: 'Funcionário', socio: 'Sócio' };
const semAcento = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function pickerPessoa(id, nome) {
  const atual = FIN_OPCOES.pessoas.find(p => p.id === id);
  return `<div class="picker" data-picker>
    <input type="hidden" name="contato_id" value="${esc(atual ? id : '')}">
    <input class="picker-q" autocomplete="off" spellcheck="false" placeholder="Busque pelo nome ou CNPJ/CPF" value="${esc(atual?.nome || nome || '')}"
      role="combobox" aria-expanded="false" aria-label="Fornecedor ou cliente">
    <ul class="picker-list" role="listbox" hidden></ul>
  </div>`;
}

function ligarPicker(root) {
  const hid = root.querySelector('input[type=hidden]'), q = root.querySelector('.picker-q'), ul = root.querySelector('.picker-list');
  let itens = [], ativo = 0;
  const nomeDe = id => FIN_OPCOES.pessoas.find(p => p.id === id)?.nome || '';
  const destacar = () => ul.querySelectorAll('li[data-i]').forEach(li => li.classList.toggle('on', Number(li.dataset.i) === ativo));
  const abrir = () => {
    const t = semAcento(q.value), dig = q.value.replace(/\D/g, '');
    itens = FIN_OPCOES.pessoas.filter(p => !t || semAcento(p.nome).includes(t) || (dig.length >= 4 && (p.documento || '').includes(dig))).slice(0, 40);
    ativo = 0;
    const exato = itens.some(p => semAcento(p.nome) === t);
    ul.innerHTML = itens.map((p, i) => `<li data-i="${i}" role="option"><b>${esc(p.nome)}</b>
        <span>${p.papeis.map(x => PAPEL_CURTO[x] || x).join(' · ')}${p.documento ? ` · ${esc(p.documento)}` : ''}</span></li>`).join('')
      + (t && !exato ? `<li data-novo class="novo">＋ Cadastrar “${esc(q.value.trim())}”</li>` : '')
      + (!itens.length && !t ? '<li class="vazio">Nenhum fornecedor cadastrado</li>' : '');
    ul.hidden = false; q.setAttribute('aria-expanded', 'true');
    destacar();
  };
  const fechar = () => { ul.hidden = true; q.setAttribute('aria-expanded', 'false'); };
  const escolher = p => {
    hid.value = p.id; q.value = p.nome; fechar();
    hid.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const cadastrar = nome => dialogoCad({
    titulo: 'Novo fornecedor ou cliente', campos: camposPessoa('financeiro'), valores: { nome, papeis: ['fornecedor'] },
    salvar: d => send('POST', 'cad/pessoas', d),
    depois: nova => { FIN_OPCOES.pessoas.push(nova); FIN_OPCOES.pessoas.sort((a, b) => a.nome.localeCompare(b.nome)); escolher(nova); },
  });
  q.addEventListener('focus', abrir);
  q.addEventListener('input', () => { hid.value = ''; abrir(); });
  q.addEventListener('keydown', e => {
    if (ul.hidden && e.key === 'ArrowDown') { abrir(); return; }
    if (e.key === 'ArrowDown') { ativo = Math.min(ativo + 1, itens.length - 1); destacar(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { ativo = Math.max(ativo - 1, 0); destacar(); e.preventDefault(); }
    else if (e.key === 'Enter' && !ul.hidden) {
      e.preventDefault();
      if (itens[ativo]) escolher(itens[ativo]); else if (q.value.trim()) cadastrar(q.value.trim());
    } else if (e.key === 'Escape') fechar();
  });
  ul.addEventListener('mousedown', e => {
    e.preventDefault();
    const li = e.target.closest('li');
    if (!li) return;
    if (li.hasAttribute('data-novo')) cadastrar(q.value.trim());
    else if (li.dataset.i) escolher(itens[Number(li.dataset.i)]);
  });
  // Sem nome livre: ao sair do campo sem escolher, volta para o cadastro escolhido (ou fica vazio).
  q.addEventListener('blur', () => setTimeout(() => { fechar(); q.value = hid.value ? nomeDe(hid.value) : ''; }, 150));
  // Usado pelo leitor de boleto: tenta achar o cadastro pelo nome lido no documento.
  root.porNome = nome => {
    const t = semAcento(nome);
    const p = FIN_OPCOES.pessoas.find(x => semAcento(x.nome) === t)
      || FIN_OPCOES.pessoas.find(x => t.length >= 4 && (semAcento(x.nome).includes(t) || t.includes(semAcento(x.nome))) && semAcento(x.nome).length >= 4);
    if (p) { escolher(p); return p; }
    hid.value = ''; q.value = nome; q.focus(); abrir();
    return null;
  };
}

// ---------------------------------------------------------------- diálogo de baixa
function dialogoPagar(t) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `
    <form method="dialog" class="dlg-body">
      <h3>${VERBO[t.tipo]} lançamento</h3>
      <p class="sub">${esc(t.contato || '—')} · ${esc(t.descricao || '')}<br>Vencimento ${dm(t.vencimento)} · valor ${money(t.valor)}</p>
      <label>Data do ${t.tipo === 'pagar' ? 'pagamento' : 'recebimento'}<input type="date" name="data" value="${hojeIso()}" required></label>
      <label>Valor ${t.tipo === 'pagar' ? 'pago' : 'recebido'}<input class="money" inputmode="decimal" name="valor" value="${fmtMoeda(t.valor_em_aberto || t.valor)}" required></label>
      <p class="sub">Entra no saldo da conta <b>${esc(t.conta_nome || 'sem conta definida')}</b> como ajuste manual.</p>
      <div class="dlg-err" hidden></div>
      <div class="actions"><button value="cancel" class="btn">Cancelar</button><button value="ok" class="btn primary">Confirmar</button></div>
    </form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await send('POST', `fin/lancamento/${t.id}/pagar`, { data_pagamento: form.data.value, valor_pago: lerMoeda(form.valor.value) });
      dlg.close();
      FIN_OPCOES = null; // saldos das contas mudaram
      FLASH = `${VERBO[t.tipo] === 'Pagar' ? 'Pagamento' : 'Recebimento'} registrado.`;
      render();
    } catch (err) {
      const box = dlg.querySelector('.dlg-err'); box.hidden = false; box.textContent = err.message;
    }
  });
  dlg.showModal();
}

// ---------------------------------------------------------------- contas a pagar / receber
const PERIODOS_FIN = [
  ['mes', 'Este mês'], ['prox', 'Próximo mês'], ['30', 'Próx. 30 dias'], ['90', 'Próx. 90 dias'], ['ant', 'Mês passado'],
];

function periodoFin(p) {
  const hoje = new Date();
  const ini1 = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  switch (p.p || 'mes') {
    case 'custom': return { ini: p.ini, fim: p.fim };
    case 'prox': { const a = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1); return { ini: iso(a), fim: iso(fimDoMes(a)) }; }
    case 'ant': { const a = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1); return { ini: iso(a), fim: iso(fimDoMes(a)) }; }
    case '30': case '90': { const f = new Date(hoje); f.setDate(f.getDate() + Number(p.p)); return { ini: iso(hoje), fim: iso(f) }; }
    default: return { ini: iso(ini1), fim: iso(fimDoMes(ini1)) };
  }
}

const irContas = mudar => {
  const atual = rota().params;
  const novo = { ...atual, ...mudar };
  Object.keys(novo).forEach(k => (novo[k] === '' || novo[k] == null) && delete novo[k]);
  location.hash = `#/fin/contas?${new URLSearchParams(novo)}`;
};

PAGES['fin/contas'] = {
  eyebrow: 'Fluxo de caixa', title: 'Contas a pagar e a receber',
  lede: 'Títulos do Nibo (só leitura) e os seus lançamentos manuais, juntos.', periodo: false,
  async render(v, p) {
    await finOpcoes();
    const tipo = p.tipo === 'receber' ? 'receber' : 'pagar';
    document.getElementById('title').textContent = tipo === 'pagar' ? 'Contas a pagar' : 'Contas a receber';
    const per = periodoFin(p);
    const status = p.status || 'todos', origem = p.origem || 'todos', cat = p.cat || '';
    const qs = new URLSearchParams({ tipo, ini: per.ini, fim: per.fim, status, origem, ...(cat && { categoria: cat }) });
    const r = await api(`fin/titulos?${qs}`);
    const t = r.totais;
    const flash = FLASH; FLASH = '';
    v.innerHTML = `
      ${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      <div class="toolbar">
        <span></span>
        <a class="btn primary" href="#/fin/novo?tipo=${tipo}">＋ Novo lançamento</a>
      </div>
      <div class="card filters">
        <div class="chips">${PERIODOS_FIN.map(([k, l]) => `<button class="chip ${(p.p || 'mes') === k ? 'on' : ''}" data-p="${k}">${l}</button>`).join('')}</div>
        <div class="filter-row">
          <label>De <input type="date" id="f-ini" value="${per.ini}"></label>
          <label>até <input type="date" id="f-fim" value="${per.fim}"></label>
          <label>Categoria <select id="f-cat">${categoriaOptions(tipo, cat, 'Todas')}</select></label>
          <label>Status <select id="f-status">
            ${[['todos', 'Todos'], ['aberto', 'Em aberto'], ['vencido', 'Vencidos'], ['pago', tipo === 'pagar' ? 'Pagos' : 'Recebidos']]
              .map(([k, l]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Origem <select id="f-origem">
            ${[['todos', 'Nibo + manual'], ['nibo', 'Só Nibo'], ['manual', 'Só manual']]
              .map(([k, l]) => `<option value="${k}" ${origem === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
      </div>
      <div class="grid g4">
        ${kpi('Em aberto', money(t.em_aberto), `${dm(r.periodo.ini)} a ${dm(r.periodo.fim)}`)}
        ${kpi('Vencido', `<span class="${t.vencido > 0 ? 'neg' : ''}">${money(t.vencido)}</span>`, 'Em aberto com vencimento antes de hoje')}
        ${kpi(tipo === 'pagar' ? 'Pago' : 'Recebido', money(t.pago), 'Títulos do período já baixados')}
        ${kpi('Títulos', t.qtd, r.linhas.length < t.qtd ? `Mostrando ${r.linhas.length}` : 'No filtro atual')}
      </div>
      <div class="card">
        ${r.linhas.length ? `<div class="table-wrap tall"><table>
          <thead><tr><th>Vencimento</th><th>Nome</th><th>Descrição</th><th>Categoria</th>
            <th class="n">Em aberto</th><th class="n">${tipo === 'pagar' ? 'Pago' : 'Recebido'}</th><th>Data pgto</th><th>Origem</th><th></th></tr></thead>
          <tbody>${r.linhas.map((l, i) => `<tr class="${l.vencido ? 'venc' : ''}">
            <td>${dmw(l.vencimento)}${l.vencido ? ' <span class="tag-venc">vencido</span>' : ''}</td>
            <td>${esc(l.contato || '—')}</td>
            <td>${esc(l.descricao || '')}${l.total_parcelas ? ` <span class="muted">(${l.parcela}/${l.total_parcelas})</span>` : ''}
              ${l.possivel_duplicado ? ' <span class="tag-dup" title="Existe título no Nibo com mesmo valor e vencimento próximo">possível duplicado</span>' : ''}</td>
            <td>${esc(l.categoria_nome || '—')}</td>
            <td class="n">${l.valor_em_aberto ? money(l.valor_em_aberto) : '—'}</td>
            <td class="n">${l.valor_pago ? money(l.valor_pago) : '—'}</td>
            <td>${l.data_pagamento ? dm(l.data_pagamento) : '—'}</td>
            <td>${badge(l.origem)}</td>
            <td class="acoes">${l.origem === 'manual' ? `
              ${l.status === 'aberto' ? `<button class="btn sm primary" data-pagar="${i}">${VERBO[tipo]}</button>` : `<button class="btn sm" data-reabrir="${l.id}">Reabrir</button>`}
              <a class="btn sm" href="#/fin/lancamento/${l.id}">Editar</a>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">Nenhum título neste filtro.</div>'}
      </div>`;

    v.querySelectorAll('[data-p]').forEach(b => b.onclick = () => irContas({ p: b.dataset.p, ini: '', fim: '' }));
    const datasMudaram = () => {
      const ini = v.querySelector('#f-ini').value, fim = v.querySelector('#f-fim').value;
      if (ini && fim && ini <= fim) irContas({ p: 'custom', ini, fim });
    };
    v.querySelector('#f-ini').onchange = datasMudaram;
    v.querySelector('#f-fim').onchange = datasMudaram;
    v.querySelector('#f-cat').onchange = e => irContas({ cat: e.target.value });
    v.querySelector('#f-status').onchange = e => irContas({ status: e.target.value });
    v.querySelector('#f-origem').onchange = e => irContas({ origem: e.target.value });
    v.querySelectorAll('[data-pagar]').forEach(b => b.onclick = () => dialogoPagar(r.linhas[Number(b.dataset.pagar)]));
    v.querySelectorAll('[data-reabrir]').forEach(b => b.onclick = async () => {
      if (!confirm('Voltar este lançamento para "em aberto"? O ajuste no saldo da conta é desfeito.')) return;
      await send('POST', `fin/lancamento/${b.dataset.reabrir}/reabrir`);
      FIN_OPCOES = null; FLASH = 'Lançamento reaberto.'; render();
    });
  },
};

// ---------------------------------------------------------------- cadastro / edição
function formLancamento(l, editando, grupo) {
  const tipo = l.tipo || 'pagar';
  return `
  <form id="flanc" class="card form" autocomplete="off">
    <div class="seg" role="radiogroup" aria-label="Tipo">
      <label><input type="radio" name="tipo" value="pagar" ${tipo === 'pagar' ? 'checked' : ''}><span>A pagar</span></label>
      <label><input type="radio" name="tipo" value="receber" ${tipo === 'receber' ? 'checked' : ''}><span>A receber</span></label>
    </div>
    <div class="form-grid">
      <label>Vencimento *<input type="date" name="vencimento" value="${l.vencimento || hojeIso()}" required></label>
      <label>Competência<input type="date" name="competencia" value="${l.competencia || ''}"></label>
      <label>Previsto para<input type="date" name="previsto_para" value="${l.previsto_para && l.previsto_para !== l.vencimento ? l.previsto_para : ''}" placeholder="igual ao vencimento"><small>Vazio = mesmo dia do vencimento. É a data usada na projeção.</small></label>
      <div class="campo span2"><span class="campo-rot">Fornecedor / cliente</span>${pickerPessoa(l.contato_id, l.contato)}</div>
      <label>Valor *<input class="money" inputmode="decimal" name="valor" value="${fmtMoeda(l.valor)}" required placeholder="0,00"></label>
      <label class="span2">Categoria<select name="categoria_id">${categoriaOptions(tipo, l.categoria_id)}</select></label>
      <label>Conta bancária<select name="conta_id">${contaOptions(l.conta_id)}</select></label>
      <label class="span3">Descrição<input name="descricao" maxlength="500" value="${esc(l.descricao || '')}"></label>
      <label>Status<select name="status">
        <option value="aberto" ${l.status !== 'pago' ? 'selected' : ''}>Em aberto</option>
        <option value="pago" ${l.status === 'pago' ? 'selected' : ''}>Pago / recebido</option></select></label>
      <label class="pago-only">Data do pagamento<input type="date" name="data_pagamento" value="${l.data_pagamento || hojeIso()}"></label>
      <label class="pago-only">Valor pago<input class="money" inputmode="decimal" name="valor_pago" value="${fmtMoeda(l.valor_pago || '')}" placeholder="igual ao valor"></label>
    </div>
    ${editando ? (grupo.length > 1 ? `
      <fieldset class="escopo"><legend>Este lançamento faz parte de ${l.recorrencia === 'parcelado' ? 'um parcelamento' : 'uma recorrência mensal'} (${l.parcela}/${l.total_parcelas})</legend>
        <label><input type="radio" name="escopo" value="este" checked> Alterar só este</label>
        <label><input type="radio" name="escopo" value="seguintes"> Alterar este e os seguintes em aberto <small>(contato, categoria, conta, descrição${l.recorrencia === 'mensal' ? ', valor' : ''}; datas ficam como estão)</small></label>
      </fieldset>` : '') : `
      <fieldset class="escopo"><legend>Repetição</legend>
        <div class="rep">
          <label><input type="radio" name="repeticao" value="nenhuma" checked> Não repete</label>
          <label><input type="radio" name="repeticao" value="mensal"> Repetir todo mês</label>
          <label><input type="radio" name="repeticao" value="parcelado"> Parcelar</label>
          <label class="vezes" hidden>Quantas vezes<input type="number" name="vezes" min="2" max="120" value="12"></label>
        </div>
        <div id="previa" class="previa" hidden></div>
      </fieldset>`}
    <div id="dups" class="alert warn" hidden></div>
    <div id="ferr" class="alert" hidden></div>
    <div class="actions">
      ${editando ? `<button type="button" class="btn danger" id="bcancelar">Cancelar lançamento</button>` : ''}
      <span style="flex:1"></span>
      <a class="btn" href="#/fin/contas?tipo=${tipo}">Voltar</a>
      <button class="btn primary" type="submit">${editando ? 'Salvar alterações' : 'Salvar lançamento'}</button>
    </div>
  </form>
`;
}

function previaParcelas(f) {
  const rep = f.repeticao?.value;
  const n = Number(f.vezes?.value) || 1;
  const valor = lerMoeda(f.valor.value) || 0;
  if (!rep || rep === 'nenhuma' || n < 2 || !f.vencimento.value) return '';
  const cent = Math.round(valor * 100), base = Math.floor(cent / n);
  const linhas = Array.from({ length: n }, (_, i) => ({
    venc: addMonths(f.vencimento.value, i),
    valor: rep === 'parcelado' ? (i === n - 1 ? cent - base * (n - 1) : base) / 100 : valor,
  }));
  const mostrar = linhas.length > 6 ? [...linhas.slice(0, 3), null, ...linhas.slice(-2)] : linhas;
  return `<b>${n} lançamentos · total ${money(linhas.reduce((s, x) => s + x.valor, 0))}</b>
    <div class="previa-list">${mostrar.map((x, i) => x ? `<span>${linhas.indexOf(x) + 1}/${n} · ${dm(x.venc)} · ${money(x.valor)}</span>` : '<span>…</span>').join('')}</div>
    ${f.status.value === 'pago' ? '<small>Só o primeiro nasce como pago; os demais ficam em aberto.</small>' : ''}`;
}

function corpoForm(f) {
  const val = n => f[n].value || null;
  return {
    tipo: f.tipo.value, vencimento: val('vencimento'), competencia: val('competencia'), previsto_para: val('previsto_para'),
    contato_id: val('contato_id'), categoria_id: val('categoria_id'), conta_id: val('conta_id'), descricao: val('descricao'),
    valor: lerMoeda(f.valor.value), status: f.status.value,
    valor_pago: f.status.value === 'pago' && f.valor_pago.value ? lerMoeda(f.valor_pago.value) : null,
    data_pagamento: f.status.value === 'pago' ? val('data_pagamento') : null,
    anexo_id: f.dataset.anexo || null,
  };
}

function ligarForm(v, { editando, l, grupo }) {
  const f = v.querySelector('#flanc');
  ligarPicker(f.querySelector('[data-picker]'));
  const atualizar = () => {
    v.querySelectorAll('.pago-only').forEach(el => el.hidden = f.status.value !== 'pago');
    if (!editando) {
      const rep = f.repeticao.value;
      v.querySelector('.vezes').hidden = rep === 'nenhuma';
      const prev = v.querySelector('#previa'), html = previaParcelas(f);
      prev.hidden = !html; prev.innerHTML = html;
    }
  };
  f.querySelectorAll('input[name=tipo]').forEach(r => r.onchange = () => {
    f.categoria_id.innerHTML = categoriaOptions(f.tipo.value, null);
    checarDup();
  });
  if (!editando) f.querySelectorAll('input[name=repeticao]').forEach(r => r.onchange = () => {
    f.vezes.value = f.repeticao.value === 'parcelado' ? 2 : 12;
    atualizar();
  });
  f.addEventListener('input', atualizar);

  let timer;
  const checarDup = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const box = v.querySelector('#dups');
      if (!f.valor.value || !f.vencimento.value) { box.hidden = true; return; }
      const n = lerMoeda(f.valor.value);
      if (isNaN(n)) { box.hidden = true; return; }
      const d = await api(`fin/duplicados?${new URLSearchParams({ tipo: f.tipo.value, valor: n.toFixed(2), vencimento: f.vencimento.value })}`).catch(() => []);
      box.hidden = !d.length;
      box.innerHTML = d.length ? `<b>Já existe no Nibo um título parecido</b> (mesmo valor, vencimento até 3 dias de diferença). Confira para não contar em dobro:<ul>${
        d.map(x => `<li>${dm(x.vencimento)} · ${esc(x.contato || '—')} · ${esc(x.descricao || '')} · ${money(x.valor)} · ${x.status}</li>`).join('')}</ul>` : '';
    }, 400);
  };
  f.valor.addEventListener('change', checarDup);
  f.vencimento.addEventListener('change', checarDup);

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const err = v.querySelector('#ferr'); err.hidden = true;
    const corpo = corpoForm(f);
    try {
      if (editando) {
        const escopo = f.escopo?.value || 'este';
        const r = await send('PUT', `fin/lancamento/${l.id}?escopo=${escopo}`, corpo);
        FLASH = r.atualizados > 1 ? `${r.atualizados} lançamentos atualizados.` : 'Lançamento atualizado.';
      } else {
        const rep = f.repeticao.value;
        const r = await send('POST', 'fin/lancamentos', { ...corpo, repeticao: rep, vezes: rep === 'nenhuma' ? 1 : Number(f.vezes.value) });
        FLASH = r.ids.length > 1 ? `${r.ids.length} lançamentos criados.` : 'Lançamento criado.';
      }
      FIN_OPCOES = null;
      const ini = parseD(corpo.vencimento);
      location.hash = `#/fin/contas?${new URLSearchParams({ tipo: corpo.tipo, p: 'custom', ini: iso(new Date(ini.getFullYear(), ini.getMonth(), 1)), fim: iso(fimDoMes(ini)), origem: 'manual' })}`;
    } catch (ex) {
      err.hidden = false; err.textContent = ex.message;
    }
  });

  v.querySelector('#bcancelar')?.addEventListener('click', async () => {
    const seguintes = grupo.length > 1 && confirm('Cancelar também os próximos lançamentos em aberto desta série?\n\nOK = este e os seguintes · Cancelar = escolher só este');
    if (!seguintes && !confirm('Cancelar só este lançamento? Ele some das listas e da projeção (fica guardado no histórico).')) return;
    const r = await send('POST', `fin/lancamento/${l.id}/cancelar?escopo=${seguintes ? 'seguintes' : 'este'}`);
    FIN_OPCOES = null;
    FLASH = `${r.cancelados} lançamento(s) cancelado(s).`;
    location.hash = `#/fin/contas?tipo=${l.tipo}`;
  });
  atualizar();
  if (!editando) checarDup();
}

PAGES['fin/novo'] = {
  eyebrow: 'Financeiro', title: 'Novo lançamento', lede: 'Conta a pagar ou a receber, com repetição mensal ou parcelamento.', periodo: false,
  async render(v, p) {
    await finOpcoes();
    v.innerHTML = formLancamento({ tipo: p.tipo === 'receber' ? 'receber' : 'pagar' }, false, []);
    ligarForm(v, { editando: false, l: {}, grupo: [] });
  },
};

PAGES['fin/lancamento'] = {
  eyebrow: 'Financeiro', title: 'Editar lançamento', lede: 'Lançamento manual. Títulos do Nibo não são editados aqui.', periodo: false,
  async render(v, p) {
    await finOpcoes();
    const r = await api(`fin/lancamento/${encodeURIComponent(p.id)}`);
    const l = r.lancamento;
    v.innerHTML = `
      ${formLancamento(l, true, r.grupo)}
      ${r.anexos.length ? `<div class="card"><h3>Boleto anexado</h3><div class="sub">Arquivo guardado no servidor junto com o lançamento</div>
        <div class="anexos">${r.anexos.map(a => `
          <a class="anexo" href="/api/fin/anexos/${a.id}/arquivo" target="_blank" rel="noopener">
            <img src="/api/fin/anexos/${a.id}/pagina/1" alt="">
            <span>${esc(a.nome)}<small>${a.paginas} página(s) · enviado em ${new Date(a.criado_em).toLocaleDateString('pt-BR')}</small></span>
          </a>`).join('')}</div></div>` : ''}
      <div class="grid g-1-1">
        ${r.grupo.length > 1 ? `<div class="card"><h3>${l.recorrencia === 'parcelado' ? 'Parcelas' : 'Recorrência'}</h3><div class="sub">Clique para abrir</div>
          ${table([
            { t: '#', f: g => `${g.parcela}/${g.total_parcelas}${g.id === l.id ? ' ◀' : ''}` },
            { t: 'Vencimento', f: g => `<a href="#/fin/lancamento/${g.id}">${dmw(g.vencimento)}</a>` },
            { t: 'Valor', n: 1, f: g => money(g.valor) },
            { t: 'Status', f: g => g.status === 'pago' ? 'Pago' : 'Em aberto' },
          ], r.grupo)}</div>` : ''}
        <div class="card"><h3>Histórico</h3><div class="sub">Registrado automaticamente pelo banco</div>
          ${table([
            { t: 'Quando', f: h => new Date(h.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) },
            { t: 'Ação', f: h => h.acao === 'insert' ? 'Criado' : 'Alterado' },
            { t: 'Status', f: h => h.status_antes && h.status_antes !== h.status_depois ? `${h.status_antes} → ${h.status_depois}` : (h.status_depois || '') },
          ], r.historico)}</div>
      </div>`;
    ligarForm(v, { editando: true, l, grupo: r.grupo });
  },
};

// ---------------------------------------------------------------- fluxo projetado
PAGES['fin/projecao'] = {
  eyebrow: 'Financeiro', title: 'Fluxo de caixa projetado',
  lede: 'Saldo de hoje nas contas + o que está previsto entrar e sair (Nibo e lançamentos manuais).', periodo: false,
  async render(v, p) {
    const dias = Number(p.dias) || 90;
    const flag = k => p[k] !== '0';
    const r = await api(`fin/projecao?${new URLSearchParams({ dias, nibo: flag('nibo'), manual: flag('manual'), vencidos: flag('vencidos') })}`);
    const t = r.totais;
    const venc = r.vencidos.reduce((a, x) => ({ e: a.e + x.entradas, s: a.s + x.saidas }), { e: 0, s: 0 });
    const ir = mudar => { location.hash = `#/fin/projecao?${new URLSearchParams({ ...p, ...mudar })}`; };
    const semanal = dias > 90;
    v.innerHTML = `
      <div class="card filters">
        <div class="chips">${[30, 60, 90, 180, 365].map(d => `<button class="chip ${dias === d ? 'on' : ''}" data-d="${d}">${d} dias</button>`).join('')}</div>
        <div class="filter-row">
          <label class="check"><input type="checkbox" data-f="nibo" ${flag('nibo') ? 'checked' : ''}> Títulos do Nibo</label>
          <label class="check"><input type="checkbox" data-f="manual" ${flag('manual') ? 'checked' : ''}> Lançamentos manuais</label>
          <label class="check"><input type="checkbox" data-f="vencidos" ${flag('vencidos') ? 'checked' : ''}> Incluir vencidos em aberto (entram hoje)</label>
        </div>
      </div>
      ${t.menor_saldo.saldo < 0 ? `<div class="alert"><b>Atenção:</b> o saldo projetado fica negativo em <b>${dmw(t.menor_saldo.data)}</b>, chegando a <b>${money(t.menor_saldo.saldo)}</b>.</div>` : ''}
      <div class="grid g4">
        ${kpi('Saldo atual', money(r.saldo_atual), 'Soma das 6 contas, com ajustes manuais')}
        ${kpi('Entradas previstas', money(t.entradas), `Até ${dm(r.fim)}`)}
        ${kpi('Saídas previstas', money(t.saidas), `Até ${dm(r.fim)}`)}
        ${kpi(`Saldo em ${dm(r.fim)}`, `<span class="${t.saldo_final < 0 ? 'neg' : ''}">${money(t.saldo_final)}</span>`,
              `Menor saldo: ${money(t.menor_saldo.saldo)} em ${dm(t.menor_saldo.data)}`)}
      </div>
      ${venc.e || venc.s ? `<div class="alert info">Há títulos vencidos em aberto: <b>${money(venc.s)}</b> a pagar e <b>${money(venc.e)}</b> a receber.
        ${flag('vencidos') ? 'Eles estão somados no dia de hoje.' : 'Eles estão fora da projeção.'}
        <a href="#/fin/contas?tipo=pagar&status=vencido&p=custom&ini=2020-01-01&fim=${hojeIso()}">Ver vencidos</a></div>` : ''}
      <div class="card"><h3>Saldo projetado</h3><div class="sub">Começa no saldo atual e soma entradas − saídas dia a dia</div>
        <div class="chart"><canvas id="c2"></canvas></div></div>
      <div class="card"><h3>Entradas x saídas previstas</h3><div class="sub">${semanal ? 'Por semana' : 'Por dia'}</div>
        ${legend([['Entradas', COL.entrada], ['Saídas', COL.saida]])}<div class="chart"><canvas id="c1"></canvas></div></div>
      <div class="card"><h3>Saldo por conta</h3><div class="sub">Os títulos do Nibo não trazem a conta, então a projeção é consolidada. Por conta aparecem só os manuais previstos.</div>
        <div class="acc-grid">${r.contas.map(c => `
          <div class="acc">
            <div class="acc-name">${esc(c.conta)}</div>
            <div class="acc-val ${c.saldo_atual < 0 ? 'neg' : ''}">${money(c.saldo_atual)}</div>
            <div class="acc-foot">Nibo ${money(c.saldo_nibo)}${c.ajuste_manual ? ` · ajuste manual ${money(c.ajuste_manual)}` : ''}</div>
            <div class="acc-foot">Última movimentação: ${c.ultima_mov ? dm(c.ultima_mov) : '—'}</div>
            ${c.manual_entradas || c.manual_saidas ? `<div class="acc-foot">Manuais previstos: +${money(c.manual_entradas)} / −${money(c.manual_saidas)}</div>` : ''}
          </div>`).join('')}</div></div>
      <div class="card"><h3>Semana a semana</h3><div class="sub">Semanas começando na segunda-feira</div>
        ${table([
          { t: 'Semana', f: w => `${dm(w.semana)} a ${dm(iso(new Date(parseD(w.semana).getTime() + 6 * 864e5)))}` },
          { t: 'Entradas', n: 1, f: w => money(w.entradas) },
          { t: 'Saídas', n: 1, f: w => money(w.saidas) },
          { t: 'Resultado', n: 1, neg: 1, raw: w => w.entradas - w.saidas, f: w => money(w.entradas - w.saidas) },
          { t: 'Saldo no fim', n: 1, neg: 1, raw: w => w.saldo_final, f: w => `<b>${money(w.saldo_final)}</b>` },
        ], r.semanas)}</div>`;

    v.querySelectorAll('[data-d]').forEach(b => b.onclick = () => ir({ dias: b.dataset.d }));
    v.querySelectorAll('[data-f]').forEach(c => c.onchange = () => ir({ [c.dataset.f]: c.checked ? '1' : '0' }));

    const base = semanal ? r.semanas.map(w => ({ label: dm(w.semana), e: w.entradas, s: w.saidas }))
      : r.serie.map(d => ({ label: dmw(d.data), e: d.entradas, s: d.saidas }));
    bars(document.getElementById('c1'), base.map(b => b.label),
      [{ label: 'Entradas', data: base.map(b => b.e), color: COL.entrada }, { label: 'Saídas', data: base.map(b => b.s), color: COL.saida }],
      { stacked: false, totalFooter: false });
    line(document.getElementById('c2'), r.serie.map(d => dmw(d.data)), 'Saldo projetado', r.serie.map(d => d.saldo), COL.saldo);
  },
};
