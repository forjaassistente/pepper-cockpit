// Cadastros, organizados por área. Novas áreas (insumos, fichas técnicas…) entram em AREAS_CAD.

const AREAS_CAD = [
  { nome: 'Financeiro', abas: [['contas', 'Contas bancárias'], ['plano', 'Plano de contas']] },
  { nome: 'Fechamento de caixa', abas: [['formas', 'Formas de pagamento']] },
  { nome: 'Pessoas', abas: [['equipe', 'Equipe'], ['forn_insumos', 'Fornecedores de insumos'], ['prestadores', 'Prestadores de serviço']] },
  { nome: 'Cardápio e estoque', abas: [['insumos', 'Insumos'], ['manufaturados', 'Manufaturados'], ['produtos', 'Produtos'], ['centrais', 'Centrais de estoque']] },
];
// nomes iguais na unidade de compra e na de saída (estoque.js monta a lista de saída a partir desta)
const UNIDADES = [['kg', 'Kg'], ['g', 'Grama (g)'], ['l', 'Litro'], ['ml', 'Mililitro (ml)'], ['un', 'Unidade'], ['cx', 'Caixa'],
  ['pct', 'Pacote'], ['dz', 'Dúzia'], ['fardo', 'Fardo'], ['m', 'Metro']];
const PAPEL_ROT = {
  fornecedor: 'Fornecedor', cliente: 'Cliente', funcionario: 'Funcionário', socio: 'Sócio',
  motoboy: 'Motoboy', free_lance: 'Free lance', responsavel_caixa: 'Responsável de caixa',
  free_lance_cozinha: 'Free lance cozinha', free_lance_salao: 'Free lance salão',
};
const TIPO_CONTA = { banco: 'Banco', dinheiro: 'Dinheiro (caixa físico)', investimento: 'Investimento', carteira: 'Carteira digital' };
const FLUXO_ROT = { operacional: 'Operacional', investimento: 'Investimento', financiamento: 'Financiamento' };

const situacao = a => a ? '<span class="badge manual">Ativo</span>' : '<span class="badge nibo">Arquivado</span>';
const chips = ps => (ps || []).map(p => `<span class="chip-p">${PAPEL_ROT[p] || p}</span>`).join(' ');
const irCad = mudar => { location.hash = `#/cadastros?${new URLSearchParams({ ...rota().params, ...mudar })}`; };

// ---------------------------------------------------------------- formulário genérico em diálogo
function dialogoCad({ titulo, campos, valores = {}, nota = '', salvar, depois, excluir }) {
  const dlg = document.getElementById('dlg');
  const campo = c => {
    const v = valores[c.k] ?? c.padrao ?? '';
    const req = c.req ? 'required' : '';
    if (c.tipo === 'select') return `<label class="${c.span ? 'span2' : ''}">${c.rot}<select name="${c.k}" ${req}>
      ${c.opcoes.map(([val, rot]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(rot)}</option>`).join('')}</select></label>`;
    if (c.tipo === 'checks') return `<fieldset class="checks span2"><legend>${c.rot}</legend>${c.opcoes.map(([val, rot]) =>
      `<label><input type="checkbox" name="${c.k}" value="${esc(val)}" ${(v || []).includes(val) ? 'checked' : ''}> ${esc(rot)}</label>`).join('')}</fieldset>`;
    if (c.tipo === 'bool') return `<label class="check-l span2"><input type="checkbox" name="${c.k}" ${v === false ? '' : 'checked'}> ${c.rot}</label>`;
    if (c.tipo === 'cpf') return `<label class="${c.span ? 'span2' : ''}">${c.rot}<input name="${c.k}" class="cpf" inputmode="numeric"
      autocomplete="off" value="${esc(fmtCpf(v))}" placeholder="000.000.000-00"></label>`;
    if (c.tipo === 'tel') return `<label class="${c.span ? 'span2' : ''}">${c.rot}<input name="${c.k}" class="phone" type="tel" inputmode="tel"
      autocomplete="off" maxlength="15" value="${esc(fmtTelefone(v))}" placeholder="(00) 00000-0000"></label>`;
    if (c.tipo === 'money') return `<label class="${c.span ? 'span2' : ''}">${c.rot}<input name="${c.k}" class="money" inputmode="decimal"
      value="${fmtMoeda(v)}" placeholder="0,00">${c.ajuda ? `<small>${c.ajuda}</small>` : ''}</label>`;
    if (c.tipo === 'textarea') return `<label class="span2">${c.rot}<textarea name="${c.k}" rows="2" maxlength="${c.max || 500}">${esc(v)}</textarea></label>`;
    return `<label class="${c.span ? 'span2' : ''}">${c.rot}<input name="${c.k}" type="${c.tipo || 'text'}" ${c.tipo === 'number' ? `step="${c.step || '0.01'}"` : ''}
      value="${esc(v)}" ${c.lista ? `list="${c.lista}"` : ''} maxlength="${c.max || 120}" ${req} placeholder="${esc(c.ph || '')}">${c.ajuda ? `<small>${c.ajuda}</small>` : ''}</label>`;
  };
  dlg.innerHTML = `<form method="dialog" class="dlg-body cad-form">
      <h3>${titulo}</h3>${nota ? `<p class="sub">${nota}</p>` : ''}
      <div class="cad-grid">${campos.map(campo).join('')}</div>
      <div class="dlg-err" hidden></div>
      <div class="actions">${excluir ? '<button type="button" class="btn perigo" data-excluir style="margin-right:auto">Excluir</button>' : ''}
        <button value="cancel" class="btn" formnovalidate>Cancelar</button><button value="ok" class="btn primary">Salvar</button></div>
    </form>`;
  dlg.classList.add('largo');
  const form = dlg.querySelector('form');
  form.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const out = {};
    campos.forEach(c => {
      if (c.tipo === 'checks') out[c.k] = [...form.querySelectorAll(`[name="${c.k}"]:checked`)].map(i => i.value);
      else if (c.tipo === 'bool') out[c.k] = form[c.k].checked;
      else if (c.tipo === 'money') out[c.k] = form[c.k].value.trim() === '' ? (c.nulo ? null : 0) : lerMoeda(form[c.k].value);
      else if (c.tipo === 'number') out[c.k] = form[c.k].value === '' ? (c.nulo ? null : 0) : Number(form[c.k].value);
      else out[c.k] = form[c.k].value.trim() === '' ? null : form[c.k].value.trim();
    });
    try {
      const r = await salvar(out);
      dlg.close(); dlg.classList.remove('largo');
      if (depois) { depois(r); return; }
      FIN_OPCOES = null;
      render();
    } catch (err) {
      const box = dlg.querySelector('.dlg-err'); box.hidden = false; box.textContent = err.message;
    }
  });
  if (excluir) dlg.querySelector('[data-excluir]').onclick = async () => {
    if (!confirm(`Excluir de vez "${valores.nome}"? Isso não pode ser desfeito.`)) return;
    try { const r = await excluir(); dlg.close(); FLASH = r?.nome ? `${r.nome} foi excluído.` : 'Excluído.'; FIN_OPCOES = null; render(); }
    catch (err) { const box = dlg.querySelector('.dlg-err'); box.hidden = false; box.textContent = err.message; }
  };
  dlg.addEventListener('close', () => dlg.classList.remove('largo'), { once: true });
  dlg.showModal();
}

// ---------------------------------------------------------------- abas
const ABAS_CAD = {
  async contas(box) {
    const contas = await api('cad/contas');
    const campos = [
      { k: 'nome', rot: 'Nome *', req: true, span: true, ph: 'Ex.: Sicoob - Despesas operacionais' },
      { k: 'tipo', rot: 'Tipo', tipo: 'select', opcoes: Object.entries(TIPO_CONTA) },
      { k: 'banco', rot: 'Banco / instituição' },
      { k: 'finalidade', rot: 'Finalidade', span: true, ph: 'Ex.: pagar despesas operacionais' },
      { k: 'saldo_inicial', rot: 'Saldo inicial', tipo: 'money' },
      { k: 'data_saldo_inicial', rot: 'Data do saldo inicial', tipo: 'date' },
      { k: 'ordem', rot: 'Ordem na lista', tipo: 'number', step: '1', padrao: 100 },
      { k: 'ativo', rot: 'Conta ativa (desmarque para arquivar)', tipo: 'bool' },
    ];
    box.innerHTML = `
      <div class="cad-head"><p class="sub">Contas onde o dinheiro entra e sai. O saldo atual = saldo inicial + movimentações do Nibo + lançamentos pagos no app.</p>
        <button class="btn primary" data-novo>＋ Nova conta</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Conta</th><th>Tipo</th><th>Banco</th><th>Finalidade</th>
        <th class="n">Saldo atual</th><th>Última mov.</th><th>Situação</th><th></th></tr></thead><tbody>
        ${contas.map((c, i) => `<tr><td><b>${esc(c.nome)}</b>${c.nibo_id ? ' <span class="badge nibo">Nibo</span>' : ''}</td>
          <td>${TIPO_CONTA[c.tipo] || c.tipo}</td><td>${esc(c.banco || '—')}</td><td>${esc(c.finalidade || '—')}</td>
          <td class="n ${c.saldo_atual < 0 ? 'neg' : ''}">${c.saldo_atual == null ? '—' : money(c.saldo_atual)}</td>
          <td>${c.ultima_mov ? dm(c.ultima_mov) : '—'}</td><td>${situacao(c.ativo)}</td>
          <td class="acoes"><button class="btn sm" data-edit="${i}">Editar</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    box.querySelector('[data-novo]').onclick = () => dialogoCad({ titulo: 'Nova conta bancária', campos, salvar: d => send('POST', 'cad/contas', d) });
    box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const c = contas[b.dataset.edit];
      dialogoCad({ titulo: `Editar ${c.nome}`, campos, valores: c,
        nota: c.nibo_id ? 'Importada do Nibo: as movimentações do Nibo continuam somando no saldo desta conta.' : '',
        salvar: d => send('PUT', `cad/contas/${c.id}`, d) });
    });
  },

  async plano(box, p) {
    const r = await api('cad/plano');
    const linhas = r.dre_linhas.filter(l => l.tipo === 'linha');
    const dreOpts = [['', '— Fora da DRE —'], ...linhas.map(l => [l.codigo, l.nome])];
    const filtroTipo = p.tipo || '', busca = (p.q || '').toLowerCase(), semDre = p.semdre === '1', arq = p.arq === '1';
    const subsVisiveis = c => c.subcategorias.filter(s => (arq || s.ativo) && (!filtroTipo || s.tipo === filtroTipo)
      && (!semDre || !s.dre_linha) && (!busca || s.nome.toLowerCase().includes(busca) || c.nome.toLowerCase().includes(busca)));
    const cats = r.categorias.filter(c => (arq || c.ativo) && subsVisiveis(c).length + (busca || semDre || filtroTipo ? 0 : 1));
    const todas = r.categorias.flatMap(c => c.subcategorias.filter(s => s.ativo));
    const porLinha = Object.fromEntries(linhas.map(l => [l.codigo, todas.filter(s => s.dre_linha === l.codigo).length]));
    const catCampos = [
      { k: 'nome', rot: 'Nome da categoria *', req: true, span: true },
      { k: 'grupo_fluxo', rot: 'Grupo no fluxo de caixa', tipo: 'select', opcoes: Object.entries(FLUXO_ROT) },
      { k: 'ordem', rot: 'Ordem', tipo: 'number', step: '1', padrao: 100 },
      { k: 'ativo', rot: 'Categoria ativa (desmarque para arquivar)', tipo: 'bool' },
    ];
    const subCampos = [
      { k: 'categoria_id', rot: 'Categoria', tipo: 'select', span: true, opcoes: r.categorias.filter(c => c.ativo).map(c => [c.id, c.nome]) },
      { k: 'nome', rot: 'Nome da subcategoria *', req: true, span: true },
      { k: 'tipo', rot: 'Tipo', tipo: 'select', opcoes: [['pagar', 'Saída (a pagar)'], ['receber', 'Entrada (a receber)']] },
      { k: 'codigo', rot: 'Código (opcional)', max: 20 },
      { k: 'dre_linha', rot: 'Linha da DRE', tipo: 'select', span: true, opcoes: dreOpts },
      { k: 'ativo', rot: 'Subcategoria ativa (desmarque para arquivar)', tipo: 'bool' },
    ];
    box.innerHTML = `
      <div class="cad-head"><p class="sub"><b>Fluxo de caixa</b> (regime de caixa, pela data do pagamento) usa o grupo da <b>categoria</b>.
        <b>DRE</b> (regime de competência, pela data de competência) usa a linha de cada <b>subcategoria</b>.</p>
        <button class="btn primary" data-novacat>＋ Nova categoria</button></div>
      <div class="plano-grid">
        <div>
          <div class="card filters"><div class="filter-row">
            <label>Buscar<input type="search" id="pc-q" value="${esc(p.q || '')}" placeholder="Nome da categoria ou subcategoria"></label>
            <label>Tipo<select id="pc-tipo"><option value="">Entradas e saídas</option>
              <option value="pagar" ${filtroTipo === 'pagar' ? 'selected' : ''}>Só saídas</option>
              <option value="receber" ${filtroTipo === 'receber' ? 'selected' : ''}>Só entradas</option></select></label>
            <label class="check"><input type="checkbox" id="pc-semdre" ${semDre ? 'checked' : ''}> Só fora da DRE</label>
            <label class="check"><input type="checkbox" id="pc-arq" ${arq ? 'checked' : ''}> Mostrar arquivadas</label>
          </div></div>
          ${cats.map(c => `<div class="card cat-card ${c.ativo ? '' : 'arq'}">
            <div class="cat-head"><div><h3>${esc(c.nome)}</h3>
              <span class="badge fluxo-${c.grupo_fluxo}">Fluxo: ${FLUXO_ROT[c.grupo_fluxo]}</span>${c.ativo ? '' : ' <span class="badge nibo">Arquivada</span>'}</div>
              <div class="leitor-acoes"><button class="btn sm" data-addsub="${c.id}">＋ Subcategoria</button><button class="btn sm" data-editcat="${c.id}">Editar</button></div></div>
            <table class="subs"><tbody>${subsVisiveis(c).map(s => `<tr class="${s.ativo ? '' : 'arq'}">
              <td>${esc(s.nome)}${s.codigo ? ` <span class="muted">${esc(s.codigo)}</span>` : ''}</td>
              <td><span class="tag-tipo ${s.tipo}">${s.tipo === 'pagar' ? 'Saída' : 'Entrada'}</span></td>
              <td><select class="dre-sel" data-dre="${s.id}" aria-label="Linha da DRE de ${esc(s.nome)}">${dreOpts.map(([v, l]) => `<option value="${v}" ${(s.dre_linha || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
              <td class="n muted" title="Títulos e lançamentos que usam">${s.usos ? `${s.usos} usos` : ''}</td>
              <td class="acoes"><button class="btn sm" data-editsub="${s.id}">Editar</button></td></tr>`).join('') || '<tr><td class="muted">Nenhuma subcategoria neste filtro.</td></tr>'}</tbody></table>
          </div>`).join('') || '<div class="card empty">Nada encontrado com esses filtros.</div>'}
        </div>
        <div class="card dre-prev"><h3>Estrutura da DRE</h3><div class="sub">Quantas subcategorias caem em cada linha</div>
          ${r.dre_linhas.map(l => l.tipo === 'subtotal' ? `<div class="dre-sub">${esc(l.nome)}</div>`
            : `<div class="dre-l"><span>${esc(l.nome)}</span><b>${porLinha[l.codigo]}</b></div>`).join('')}
          <div class="dre-l fora"><span>Fora da DRE (empréstimos, aportes, investimentos…)</span><b>${todas.filter(s => !s.dre_linha).length}</b></div>
        </div>
      </div>`;
    let t;
    box.querySelector('#pc-q').oninput = e => { clearTimeout(t); t = setTimeout(() => irCad({ q: e.target.value }), 400); };
    box.querySelector('#pc-tipo').onchange = e => irCad({ tipo: e.target.value });
    box.querySelector('#pc-semdre').onchange = e => irCad({ semdre: e.target.checked ? '1' : '' });
    box.querySelector('#pc-arq').onchange = e => irCad({ arq: e.target.checked ? '1' : '' });
    const acharSub = id => r.categorias.flatMap(c => c.subcategorias).find(s => s.id === id);
    box.querySelectorAll('[data-dre]').forEach(sel => sel.onchange = async () => {
      sel.disabled = true;
      try { await send('POST', 'cad/subcategorias/dre', { ids: [sel.dataset.dre], dre_linha: sel.value || null }); sel.classList.add('salvo'); setTimeout(() => sel.classList.remove('salvo'), 1200); }
      catch (e) { alert(e.message); }
      sel.disabled = false;
    });
    box.querySelector('[data-novacat]').onclick = () => dialogoCad({ titulo: 'Nova categoria', campos: catCampos, salvar: d => send('POST', 'cad/categorias', d) });
    box.querySelectorAll('[data-editcat]').forEach(b => b.onclick = () => {
      const c = r.categorias.find(x => x.id === b.dataset.editcat);
      dialogoCad({ titulo: `Editar categoria`, campos: catCampos, valores: c, salvar: d => send('PUT', `cad/categorias/${c.id}`, d) });
    });
    box.querySelectorAll('[data-addsub]').forEach(b => b.onclick = () => dialogoCad({ titulo: 'Nova subcategoria', campos: subCampos,
      valores: { categoria_id: b.dataset.addsub, tipo: 'pagar' }, salvar: d => send('POST', 'cad/subcategorias', d) }));
    box.querySelectorAll('[data-editsub]').forEach(b => b.onclick = () => {
      const s = acharSub(b.dataset.editsub);
      dialogoCad({ titulo: 'Editar subcategoria', campos: subCampos, valores: s,
        nota: s.nibo_id ? 'Importada do Nibo: títulos do Nibo com esta categoria continuam ligados a ela.' : '',
        salvar: d => send('PUT', `cad/subcategorias/${s.id}`, d) });
    });
  },

  async equipe(box, p) { return abaPessoas(box, p, 'equipe'); },
  async forn_insumos(box, p) { return abaPessoas(box, p, 'forn_insumos'); },
  async prestadores(box, p) { return abaPessoas(box, p, 'prestadores'); },

  insumos: (box, p) => abaCardapioEstoque(box, p, 'insumo'),
  manufaturados: (box, p) => abaCardapioEstoque(box, p, 'manufaturado'),
  produtos: (box, p) => abaCardapioEstoque(box, p, 'produto'),
  centrais: (box, p) => abaCentrais(box, p),

  async formas(box) {
    const [formas, op] = await Promise.all([api('cad/formas'), api('fin/opcoes')]);
    const grupos = [...new Set(formas.map(f => f.conferencia).filter(g => g !== 'gaveta'))];
    const campos = [
      { k: 'nome', rot: 'Nome *', req: true, span: true, ph: 'Ex.: iFood' },
      { k: 'conferencia', rot: 'Onde é conferida *', req: true, span: true, lista: 'dl-grupos-conf',
        ajuda: '"gaveta" = dinheiro do canal (entra na conta do troco). Outro nome = grupo conferido junto, ex.: "Máquina cartão" soma débito + crédito + pix da máquina.' },
      { k: 'canais', rot: 'Aparece no fechamento de', tipo: 'checks', opcoes: [['Salão', 'Salão'], ['Delivery', 'Delivery']], padrao: ['Salão', 'Delivery'] },
      { k: 'taxa_percentual', rot: 'Taxa (%)', tipo: 'number', step: '0.001', nulo: true, ajuda: 'Informativo, para análises futuras' },
      { k: 'prazo_recebimento', rot: 'Prazo de recebimento (dias)', tipo: 'number', step: '1', nulo: true },
      { k: 'ordem', rot: 'Ordem no fechamento', tipo: 'number', step: '1', padrao: 100 },
      { k: 'conferir_no_caixa', rot: 'Conferir no fechamento de caixa ("deve ter")', tipo: 'bool', padrao: true,
        ajuda: 'Desmarque quando o valor lançado já basta (ex.: app de pagamento que você confere direto no extrato).' },
      { k: 'descricao_lanc', rot: 'Descrição no fluxo de caixa', span: true, ph: 'Ex.: Recebimento máquina cartão', max: 120,
        ajuda: 'Formas do mesmo grupo de conferência viram um lançamento só (ex.: débito + crédito + pix da maquininha).' },
      { k: 'conta_id', rot: 'Conta em que o dinheiro cai', tipo: 'select', nulo: true,
        opcoes: [['', '— Escolher na hora —'], ...op.contas.map(c => [c.id, c.conta])] },
      { k: 'categoria_id', rot: 'Categoria (receita)', tipo: 'select', nulo: true,
        opcoes: [['', '— Escolher na hora —'], ...op.categorias.filter(c => c.tipo === 'receber').map(c => [c.id, c.categoria])] },
      { k: 'ativo', rot: 'Forma ativa (desmarque para arquivar)', tipo: 'bool' },
    ];
    box.innerHTML = `
      <div class="cad-head"><p class="sub">Formas de pagamento do fechamento de caixa. A conferência ("deve ter") é montada a partir de onde cada forma é conferida.</p>
        <button class="btn primary" data-novo>＋ Nova forma</button></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Forma</th><th>Conferida em</th><th>Cai na conta</th><th>Canais</th>
        <th class="n">Taxa</th><th class="n">Prazo</th><th class="n">Usos</th><th>Situação</th><th></th></tr></thead><tbody>
        ${formas.map((f, i) => `<tr><td><b>${esc(f.nome)}</b></td>
          <td>${f.conferencia === 'gaveta' ? 'Gaveta do canal (dinheiro)' : esc(f.conferencia)}${f.conferencia !== 'gaveta' && !f.conferir_no_caixa ? ' <small class="muted">· sem conferência</small>' : ''}</td>
          <td>${f.conta_nome ? esc(f.conta_nome) : '<span class="muted">escolher na hora</span>'}${f.prazo_recebimento ? ` <small class="muted">· D+${f.prazo_recebimento}</small>` : ''}</td>
          <td>${f.canais.join(', ')}</td><td class="n">${f.taxa_percentual != null ? `${num1.format(f.taxa_percentual)}%` : '—'}</td>
          <td class="n">${f.prazo_recebimento != null ? `${f.prazo_recebimento} d` : '—'}</td><td class="n">${f.usos || ''}</td>
          <td>${situacao(f.ativo)}</td><td class="acoes"><button class="btn sm" data-edit="${i}">Editar</button></td></tr>`).join('')}
      </tbody></table></div></div>
      <datalist id="dl-grupos-conf"><option value="gaveta">${grupos.map(g => `<option value="${esc(g)}">`).join('')}</datalist>`;
    box.querySelector('[data-novo]').onclick = () => dialogoCad({ titulo: 'Nova forma de pagamento', campos, salvar: d => send('POST', 'cad/formas', d) });
    box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const f = formas[b.dataset.edit];
      dialogoCad({ titulo: `Editar ${f.nome}`, campos, valores: f,
        nota: f.usos ? 'Renomear atualiza também os fechamentos já feitos com esta forma.' : '',
        salvar: d => send('PUT', `cad/formas/${f.id}`, d) });
    });
  },
};

// Áreas de Cadastros › Pessoas. 'financeiro' (todos os contatos) segue para os cadastros rápidos do financeiro e da caixa de entrada.
const GRUPO_FORN = [['insumos', 'Fornecedor de insumos'], ['servicos', 'Prestador de serviço']];
const AREA_PESSOA = {
  equipe: { titulo: 'pessoa da equipe', papeis: ['socio', 'funcionario', 'motoboy', 'free_lance_cozinha', 'free_lance_salao', 'responsavel_caixa'],
            sub: 'Sócios, funcionários, motoboys, free lances e responsáveis de caixa (sugeridos no fechamento). Uma pessoa pode ter mais de uma função.' },
  forn_insumos: { titulo: 'fornecedor de insumos', grupo: 'insumos', hist: true,
            sub: 'Quem vende comida, bebida e embalagem. É daqui que sai o fornecedor padrão dos insumos (e, depois, a lista de compras).' },
  prestadores: { titulo: 'prestador de serviço', grupo: 'servicos', hist: true,
            sub: 'Sistemas, contador, aluguel, energia, internet, manutenção, marketing e demais despesas da operação.' },
  financeiro: { titulo: 'fornecedor ou cliente', papeis: ['fornecedor', 'cliente', 'funcionario', 'socio'], hist: true, sub: '' },
};
const ehFornArea = area => !!AREA_PESSOA[area].grupo;

function camposPessoa(area) {
  const cfg = AREA_PESSOA[area];
  const contato = [
    { k: 'tipo_pessoa', rot: 'Pessoa', tipo: 'select', opcoes: [['', '—'], ['PJ', 'Jurídica (CNPJ)'], ['PF', 'Física (CPF)']] },
    { k: 'documento', rot: 'CNPJ / CPF', max: 20 },
    { k: 'telefone', rot: 'Telefone', tipo: 'tel' }, { k: 'email', rot: 'E-mail', tipo: 'email' },
    { k: 'chave_pix', rot: 'Chave Pix', span: true },
  ];
  const fim = [{ k: 'observacao', rot: 'Observações', tipo: 'textarea' }, { k: 'ativo', rot: 'Cadastro ativo (desmarque para arquivar)', tipo: 'bool' }];
  if (area === 'equipe') return [
    { k: 'nome', rot: 'Nome *', req: true, span: true },
    { k: 'papeis', rot: 'Função', tipo: 'checks', opcoes: cfg.papeis.map(x => [x, PAPEL_ROT[x]]), padrao: ['motoboy'] },
    { k: 'diaria_padrao', rot: 'Diária padrão (R$)', tipo: 'money', nulo: true, ajuda: 'Preenche sozinho no fechamento' },
    { k: 'telefone', rot: 'Telefone', tipo: 'tel' }, { k: 'chave_pix', rot: 'Chave Pix', span: true }, ...fim];
  if (ehFornArea(area)) return [
    { k: 'nome', rot: 'Nome / razão social *', req: true, span: true },
    { k: 'tipo_fornecedor', rot: 'Grupo', tipo: 'select', opcoes: GRUPO_FORN, padrao: cfg.grupo }, ...contato, ...fim];
  return [
    { k: 'nome', rot: 'Nome / razão social *', req: true, span: true },
    { k: 'papeis', rot: 'É', tipo: 'checks', opcoes: cfg.papeis.map(x => [x, PAPEL_ROT[x]]), padrao: [cfg.papeis[0]] },
    ...(area === 'financeiro' ? [{ k: 'tipo_fornecedor', rot: 'Se for fornecedor, grupo', tipo: 'select', opcoes: GRUPO_FORN, padrao: 'servicos' }] : []),
    ...contato, ...fim];
}

// Free lance: no banco é o papel "free_lance" + free_lance_areas (cozinha/salão); na tela vira "Free lance cozinha/salão".
const papeisTela = x => [...x.papeis.filter(pp => pp !== 'free_lance'),
  ...(x.papeis.includes('free_lance') ? (x.free_lance_areas || []).map(a => `free_lance_${a}`) : [])];
function papeisBanco(telaPapeis, original) {
  const areas = telaPapeis.filter(pp => pp.startsWith('free_lance_')).map(pp => pp.slice(11));
  const outros = telaPapeis.filter(pp => !pp.startsWith('free_lance_'));
  // free lance antigo sem área definida continua free lance até alguém escolher a área
  const ficaFL = areas.length || (original?.papeis?.includes('free_lance') && !(original.free_lance_areas || []).length);
  return { papeis: [...outros, ...(ficaFL ? ['free_lance'] : [])], free_lance_areas: areas };
}
const FUNCOES_FILTRO = [['socio', 'Sócios'], ['funcionario', 'Funcionários'], ['motoboy', 'Motoboys'], ['free_lance', 'Free lances (todos)'],
  ['free_lance_cozinha', 'Free lance cozinha'], ['free_lance_salao', 'Free lance salão'], ['responsavel_caixa', 'Responsáveis de caixa']];
const temFuncao = (x, f) => f === 'free_lance' ? x.papeis.includes('free_lance') : papeisTela(x).includes(f);

async function abaPessoas(box, p, area) {
  const cfg = AREA_PESSOA[area], forn = ehFornArea(area), equipe = area === 'equipe';
  const todos = await api(`cad/pessoas?${new URLSearchParams({ area, busca: p.q || '', inativos: p.arq === '1' })}`);
  const funcao = equipe && FUNCOES_FILTRO.some(([k]) => k === p.funcao) ? p.funcao : '';
  const lista = funcao ? todos.filter(x => temFuncao(x, funcao)) : todos;
  const papeis = forn ? ['fornecedor'] : cfg.papeis;
  const campos = camposPessoa(area);
  box.innerHTML = `
    <div class="cad-head"><p class="sub">${cfg.sub}</p><div class="actions"><button class="btn" data-unificar title="Juntar cadastros repetidos da mesma pessoa">Unificar duplicados</button>
      <button class="btn primary" data-novo>＋ Novo ${cfg.titulo}</button></div></div>
    <div class="card filters"><div class="filter-row">
      ${equipe ? `<label>Função<select id="ps-funcao"><option value="">Todas as funções (${todos.length})</option>
        ${FUNCOES_FILTRO.map(([k, rot]) => `<option value="${k}" ${k === funcao ? 'selected' : ''}>${rot} (${todos.filter(x => temFuncao(x, k)).length})</option>`).join('')}
        </select></label>` : ''}
      <label>Buscar<input type="search" id="ps-q" value="${esc(p.q || '')}" placeholder="Nome${equipe ? '' : ' ou documento'}"></label>
      <label class="check"><input type="checkbox" id="ps-arq" ${p.arq === '1' ? 'checked' : ''}> Mostrar arquivados</label>
      <span class="muted">${lista.length}${todos.length === 1000 ? '+' : ''} cadastro(s)</span>
    </div></div>
    <div class="card"><div class="table-wrap tall"><table><thead><tr><th>Nome</th>${forn ? '' : `<th>${equipe ? 'Função' : 'Papéis'}</th>`}
      ${equipe ? '<th class="n">Diária padrão</th><th>Telefone</th><th>Chave Pix</th>' : '<th>Documento</th><th>Telefone</th><th>E-mail</th>'}
      <th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map((x, i) => `<tr><td>${cfg.hist ? `<button class="link-nome" data-hist="${i}">${esc(x.nome)}</button>` : `<b>${esc(x.nome)}</b>`}${x.nibo_id ? ' <span class="badge nibo">Nibo</span>' : ''}</td>
        ${forn ? '' : `<td>${chips(papeisTela(x).filter(pp => papeis.includes(pp)))}${x.papeis.includes('free_lance') && !(x.free_lance_areas || []).length
          ? ' <span class="chip-p aviso">Free lance: área?</span>' : ''}</td>`}
        ${equipe ? `<td class="n">${x.diaria_padrao != null ? money(x.diaria_padrao) : '—'}</td><td>${linkZap(x.telefone)
          ? `<a href="${linkZap(x.telefone)}" target="_blank" rel="noopener" class="zap">${esc(fmtTelefone(x.telefone))}</a>` : esc(fmtTelefone(x.telefone) || '—')}</td><td>${esc(x.chave_pix || '—')}</td>`
          : `<td>${esc(x.documento || '—')}</td><td>${esc(fmtTelefone(x.telefone) || '—')}</td><td>${esc(x.email || '—')}</td>`}
        <td>${situacao(x.ativo)}</td><td class="acoes"><button class="btn sm" data-edit="${i}">Editar</button></td></tr>`).join('')
        || '<tr><td colspan="7" class="muted">Nenhum cadastro encontrado.</td></tr>'}
    </tbody></table></div></div>`;
  let t;
  box.querySelector('#ps-q').oninput = e => { clearTimeout(t); t = setTimeout(() => irCad({ q: e.target.value }), 400); };
  box.querySelector('#ps-arq').onchange = e => irCad({ arq: e.target.checked ? '1' : '' });
  if (equipe) box.querySelector('#ps-funcao').onchange = e => irCad({ funcao: e.target.value });
  // fornecedor: o papel é sempre "fornecedor" e o grupo vem do campo Grupo
  const corpo = (x, d, outros) => {
    const tela = forn ? ['fornecedor'] : d.papeis;
    const { papeis: pb, free_lance_areas } = equipe ? papeisBanco(tela, x) : { papeis: tela, free_lance_areas: x.free_lance_areas || [] };
    return { ...x, ...d, papeis: [...new Set([...outros, ...pb])], free_lance_areas };
  };
  box.querySelector('[data-novo]').onclick = () => dialogoCad({ titulo: `Novo ${cfg.titulo}`, campos,
    valores: equipe && funcao && funcao !== 'free_lance' ? { papeis: [funcao] } : {},
    salvar: d => send('POST', 'cad/pessoas', corpo({}, d, [])) });
  box.querySelector('[data-unificar]').onclick = () => dialogoUnificar();
  box.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => historicoPessoa(lista[b.dataset.hist].id));
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const x = lista[b.dataset.edit];
    const outros = x.papeis.filter(pp => pp !== 'free_lance' && !papeis.includes(pp));   // papéis de outras áreas são preservados
    const semArea = equipe && x.papeis.includes('free_lance') && !(x.free_lance_areas || []).length;
    dialogoCad({ titulo: `Editar ${x.nome}`, campos, valores: { ...x, papeis: equipe ? papeisTela(x) : x.papeis },
      nota: [outros.length ? `Também é: ${outros.map(pp => PAPEL_ROT[pp]).join(', ')} (mantido).` : '',
             semArea ? 'É free lance, mas sem área definida: marque Free lance cozinha e/ou salão.' : ''].filter(Boolean).join(' '),
      salvar: d => send('PUT', `cad/pessoas/${x.id}`, corpo(x, d, outros)),
      excluir: () => send('DELETE', `cad/pessoas/${x.id}`) });
  });
}

async function historicoPessoa(id) {
  const dlg = document.getElementById('dlg');
  dlg.className = 'dlg xl';
  dlg.addEventListener('close', () => { dlg.className = 'dlg'; }, { once: true });
  dlg.innerHTML = '<div class="dlg-body"><div class="loading">Carregando histórico…</div></div>';
  dlg.showModal();
  const r = await api(`cad/pessoas/${id}/historico`);
  const x = r.pessoa, rs = r.resumo;
  const meses = [];
  const hoje = new Date();
  for (let i = 11; i >= 0; i--) { const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1); meses.push(iso(d).slice(0, 7)); }
  const porMes = Object.fromEntries(r.meses.map(m => [m.mes, m.valor]));
  const maxMes = Math.max(...meses.map(m => porMes[m] || 0), 1);
  dlg.innerHTML = `<div class="dlg-body hist">
    <div class="hist-head">
      <div><h3>${esc(x.nome)}</h3><div class="sub">${chips(x.papeis)} ${x.documento ? `· ${esc(x.documento)}` : ''} ${x.telefone ? `· ${esc(fmtTelefone(x.telefone))}` : ''}</div></div>
      <form method="dialog"><button class="btn sm" value="fechar">Fechar</button></form>
    </div>
    <div class="grid g4">
      ${kpi('Pago nos últimos 12 meses', money(rs.pago_12m), `Total histórico: ${money(rs.total_pago)}`)}
      ${kpi('Em aberto', money(rs.em_aberto), rs.vencido ? `<span class="neg">${money(rs.vencido)} vencido</span>` : 'Nada vencido')}
      ${kpi('Pagamentos', rs.qtd_pagos, rs.primeiro_pagamento ? `Desde ${dm(rs.primeiro_pagamento)}/${rs.primeiro_pagamento.slice(0, 4)}` : 'Nenhum ainda')}
      ${kpi('Último pagamento', rs.ultimo_pagamento ? `${dm(rs.ultimo_pagamento)}/${rs.ultimo_pagamento.slice(2, 4)}` : '—', rs.total_recebido ? `Recebido dele: ${money(rs.total_recebido)}` : '')}
    </div>
    <div class="card"><h3>Pago por mês</h3><div class="sub">Últimos 12 meses, pela data do pagamento</div>
      <div class="mes-bars">${meses.map(m => `<div class="mb" title="${m.slice(5)}/${m.slice(0, 4)}: ${money(porMes[m] || 0)}">
        <span class="v">${porMes[m] ? brl0.format(porMes[m]) : ''}</span>
        <i style="height:${Math.round((porMes[m] || 0) / maxMes * 100)}%"></i><span class="m">${MESES_CURTOS[Number(m.slice(5)) - 1]}</span></div>`).join('')}</div>
    </div>
    <div class="card"><h3>Títulos</h3><div class="sub">Nibo e lançamentos do app, mais recentes primeiro${r.titulos.length === 500 ? ' (últimos 500)' : ''}</div>
      ${table([
        { t: 'Vencimento', f: t => dm(t.vencimento) + '/' + t.vencimento.slice(2, 4) },
        { t: 'Pagamento', f: t => t.data_pagamento ? dm(t.data_pagamento) + '/' + t.data_pagamento.slice(2, 4) : (t.vencido ? '<span class="tag-venc">vencido</span>' : '—') },
        { t: 'Descrição', f: t => esc(t.descricao || '—') },
        { t: 'Categoria', f: t => esc(t.categoria_nome || '—') },
        { t: 'Valor', n: 1, f: t => `${t.tipo === 'receber' ? '+' : ''}${money(t.valor)}` },
        { t: 'Situação', f: t => t.status === 'pago' ? (t.tipo === 'pagar' ? 'Pago' : 'Recebido') : 'Em aberto' },
        { t: 'Origem', f: t => badge(t.origem) },
      ], r.titulos) }
    </div>
  </div>`;
}
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// ---------------------------------------------------------------- cardápio e estoque
async function gerenciarCategorias(grupo) {
  const cats = await api(`cad/categorias-itens?grupo=${grupo}`);
  const dlg = document.getElementById('dlg');
  dlg.className = 'dlg';
  const campos = [{ k: 'nome', rot: 'Nome da categoria *', req: true, span: true },
                  { k: 'ordem', rot: 'Ordem', tipo: 'number', step: '1', padrao: 100 },
                  { k: 'ativo', rot: 'Categoria ativa (desmarque para arquivar)', tipo: 'bool' }];
  dlg.innerHTML = `<div class="dlg-body">
    <div class="hist-head"><div><h3>Categorias de ${grupo === 'insumo' ? 'insumos' : 'produtos'}</h3>
      <div class="sub">Arquivar esconde a categoria das listas; os itens continuam cadastrados.</div></div>
      <form method="dialog"><button class="btn sm">Fechar</button></form></div>
    ${table([{ t: 'Categoria', f: c => `<b>${esc(c.nome)}</b>` }, { t: 'Itens', n: 1, f: c => c.itens },
             { t: 'Situação', f: c => situacao(c.ativo) }, { t: '', f: (c, i) => `<button class="btn sm" data-editcat="${c.id}">Editar</button>` }], cats)}
    <div class="actions"><button class="btn primary" data-novacat>＋ Nova categoria</button></div></div>`;
  dlg.querySelector('[data-novacat]').onclick = () => dialogoCad({ titulo: 'Nova categoria', campos,
    salvar: d => send('POST', 'cad/categorias-itens', { ...d, grupo }) });
  dlg.querySelectorAll('[data-editcat]').forEach(b => b.onclick = () => {
    const c = cats.find(x => x.id === b.dataset.editcat);
    dialogoCad({ titulo: `Editar ${c.nome}`, campos, valores: c, salvar: d => send('PUT', `cad/categorias-itens/${c.id}`, { ...d, grupo }) });
  });
  if (!dlg.open) dlg.showModal();
}


// ---------------------------------------------------------------- ficha técnica e CMV teórico
const FATOR_UN = { 'kg>g': 1000, 'l>ml': 1000, 'dz>un': 12 };
function converterUn(qtd, de, para) {
  if (de === para) return qtd;
  if (FATOR_UN[`${para}>${de}`]) return qtd / FATOR_UN[`${para}>${de}`];
  if (FATOR_UN[`${de}>${para}`]) return qtd * FATOR_UN[`${de}>${para}`];
  return null;
}
const lerQtd = v => Number(String(v ?? '').trim().replace(/\./g, (m, i, s) => (s.includes(',') ? '' : '.')).replace(',', '.'));
const fmtQtd = n => n == null || isNaN(n) ? '' : String(Math.round(n * 10000) / 10000).replace('.', ',');
const corCmv = c => c == null ? '' : c <= 30 ? 'cmv-ok' : c <= 35 ? 'cmv-atencao' : 'cmv-alto';
const pct1 = v => v == null ? '—' : `${num1.format(v)}%`;

PAGES['cadastros'] = {
  eyebrow: 'Cadastros', title: 'Cadastros', lede: 'Tudo o que as outras telas usam, separado por área.', periodo: false,
  async render(v, p) {
    // links antigos (aba "Ficha técnica" e tela única "cardapio") abrem a sub-aba certa de Cardápio e estoque
    if (p.aba === 'pessoas') { location.replace('#/cadastros?aba=forn_insumos'); return; }   // antiga "Fornecedores e clientes"
    if (p.aba === 'clientes') { location.replace('#/cadastros?aba=equipe'); return; }
    if (p.aba === 'fichas' || p.aba === 'cardapio') {
      const [t, id] = (p.item || '').split(':');
      const tipo = t || p.tipo || 'produto';
      const aba = { insumo: 'insumos', manufaturado: 'manufaturados', produto: 'produtos' }[tipo] || 'produtos';
      location.replace(`#/cadastros?aba=${aba}${id ? `&item=${tipo}:${id}` : ''}`); return;
    }
    const aba = ABAS_CAD[p.aba] ? p.aba : 'contas';
    const res = await api('cad/resumo');
    const conta = { contas: res.contas, plano: res.subcategorias, formas: res.formas, equipe: res.equipe,
                    forn_insumos: res.forn_insumos, prestadores: res.prestadores,
                    insumos: res.insumos, manufaturados: res.manufaturados, produtos: res.produtos, centrais: res.centrais };
    const flash = FLASH; FLASH = '';
    v.innerHTML = `
      ${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      <div class="cad-nav">
        <div class="cad-atual"><span class="cad-area-t">${AREAS_CAD.find(a => a.abas.some(([k]) => k === aba)).nome}</span>
          <b>${AREAS_CAD.flatMap(a => a.abas).find(([k]) => k === aba)[1]}</b> <span class="muted">· ${conta[aba] ?? 0} cadastro(s)</span></div>
        <button class="btn sm" id="nibo" title="Traz contas, categorias e contatos criados no Nibo que ainda não existem aqui">Trazer novidades do Nibo</button>
      </div>
      <section id="cad-box" class="view"></section>`;
    v.querySelector('#nibo').onclick = async () => {
      const r = await send('POST', 'cad/importar-nibo');
      const tot = Object.values(r).reduce((s, n) => s + n, 0);
      FLASH = tot ? `Importado do Nibo: ${r.contas} conta(s), ${r.categorias} categoria(s), ${r.subcategorias} subcategoria(s), ${r.pessoas} contato(s).` : 'Nada novo no Nibo.';
      FIN_OPCOES = null; render();
    };
    await ABAS_CAD[aba](v.querySelector('#cad-box'), p);
  },
};

// ---------------------------------------------------------------- unificar pessoas duplicadas (servidor: cadastros.unificar)
const ROT_PAPEL_UN = { fornecedor: 'Fornecedor', cliente: 'Cliente', funcionario: 'Funcionário', socio: 'Sócio', free_lance: 'Free lance',
  motoboy: 'Motoboy', responsavel_caixa: 'Resp. caixa' };
async function dialogoUnificar() {
  const dlg = document.getElementById('dlg');
  dlg.className = 'dlg xl';
  dlg.addEventListener('close', () => { dlg.className = 'dlg'; }, { once: true });
  dlg.innerHTML = '<div class="dlg-body"><div class="loading">Procurando duplicados…</div></div>';
  dlg.showModal();
  const sug = await api('cad/pessoas/duplicados');
  let mao = [];   // seleção manual
  const pessoaLinha = (x, grupo, principal) => `<label class="un-pessoa">
      <input type="radio" name="pr-${grupo}" value="${x.id}" ${principal ? 'checked' : ''} title="Fica como principal">
      <span><b>${esc(x.nome)}</b>${x.nibo ? ' <span class="badge nibo">Nibo</span>' : ''}${x.ativo ? '' : ' <span class="muted">(arquivado)</span>'}
        <small>${(x.papeis || []).map(r => ROT_PAPEL_UN[r] || r).join(', ')}${x.documento ? ` · ${esc(x.documento)}` : ''}</small></span>
      ${grupo === 'mao' ? `<button type="button" class="ico-btn" data-tirar="${x.id}" aria-label="Tirar">×</button>` : ''}</label>`;
  const desenhar = () => {
    dlg.innerHTML = `<div class="dlg-body">
      <div class="hist-head"><div><h3>Unificar pessoas duplicadas</h3>
        <div class="sub">Marque qual cadastro <b>fica</b> (●). Os outros viram parte dele: lançamentos (inclusive os do Nibo), RH, notas e fechamentos de caixa passam para o principal.
        Os repetidos saem das listas, mas não são apagados — assim a sincronização com o Nibo não os recria.</div></div>
        <form method="dialog"><button class="btn sm">Fechar</button></form></div>
      <div class="dlg-err" hidden></div>
      <h4 class="un-tit">Juntar à mão</h4>
      <div class="un-busca"><input id="un-q" placeholder="Busque pelo nome (ex.: Milena) e adicione as pessoas que são a mesma" autocomplete="off"><div id="un-res"></div></div>
      ${mao.length ? `<div class="un-grupo" data-g="mao">${mao.map((x, i) => pessoaLinha(x, 'mao', i === 0)).join('')}
        <button class="btn primary sm" data-unir="mao" ${mao.length < 2 ? 'disabled' : ''}>Unificar ${mao.length} cadastros</button></div>` : ''}
      <h4 class="un-tit">Sugestões (mesmo nome ou mesmo CPF/CNPJ) <span class="muted">${sug.length}</span></h4>
      ${sug.map((g, gi) => `<div class="un-grupo" data-g="${gi}">${g.pessoas.map((x, i) => pessoaLinha(x, gi, i === 0)).join('')}
        <button class="btn sm" data-unir="${gi}">Unificar</button></div>`).join('') || '<p class="muted">Nenhuma sugestão óbvia.</p>'}
    </div>`;
    const err = dlg.querySelector('.dlg-err');
    const q = dlg.querySelector('#un-q'), res = dlg.querySelector('#un-res');
    let t;
    q.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
      const b = q.value.trim();
      if (b.length < 2) { res.innerHTML = ''; return; }
      const [a1, a2] = await Promise.all(['financeiro', 'equipe'].map(a => api(`cad/pessoas?${new URLSearchParams({ area: a, busca: b, inativos: 'true' })}`)));
      const vistos = new Set(mao.map(x => x.id));
      const lista = [...a1, ...a2].filter(x => !vistos.has(x.id) && vistos.add(x.id)).slice(0, 12);
      res.innerHTML = lista.map(x => `<button type="button" class="un-add" data-add='${esc(JSON.stringify({ id: x.id, nome: x.nome, papeis: x.papeis, documento: x.documento, ativo: x.ativo, nibo: !!x.nibo_id }))}'>
        ＋ ${esc(x.nome)} <small>${(x.papeis || []).map(r => ROT_PAPEL_UN[r] || r).join(', ')}${x.nibo_id ? ' · Nibo' : ''}</small></button>`).join('') || '<p class="muted small-txt">Ninguém com esse nome.</p>';
    }, 250); };
    dlg.onclick = async e => {
      const add = e.target.closest('[data-add]');
      if (add) { mao.push(JSON.parse(add.dataset.add)); desenhar(); dlg.querySelector('#un-q').focus(); return; }
      const tira = e.target.closest('[data-tirar]');
      if (tira) { mao = mao.filter(x => x.id !== tira.dataset.tirar); desenhar(); return; }
      const b = e.target.closest('[data-unir]');
      if (!b) return;
      const g = b.dataset.unir, caixa = b.closest('.un-grupo');
      const pessoas = g === 'mao' ? mao : sug[g].pessoas;
      const principal = caixa.querySelector('input[type=radio]:checked').value;
      const outros = pessoas.filter(x => x.id !== principal);
      const pn = pessoas.find(x => x.id === principal).nome;
      if (!confirm(`Unificar em “${pn}”?\n\n${outros.map(x => '• ' + x.nome).join('\n')}\n\npassam a fazer parte de “${pn}”. Isso não pode ser desfeito pelo app.`)) return;
      try {
        await send('POST', 'cad/pessoas/unificar', { principal_id: principal, outros: outros.map(x => x.id) });
        if (g === 'mao') mao = []; else sug.splice(Number(g), 1);
        desenhar();
        const ok = document.createElement('div'); ok.className = 'alert ok'; ok.textContent = `Pronto: tudo agora está em “${pn}”.`;
        dlg.querySelector('.dlg-body').insertBefore(ok, dlg.querySelector('.dlg-err'));
        FIN_OPCOES = null;
      } catch (ex) { err.hidden = false; err.textContent = ex.message; err.scrollIntoView({ block: 'nearest' }); }
    };
  };
  desenhar();
  dlg.addEventListener('close', () => render(), { once: true });   // atualiza a lista de pessoas atrás
}
