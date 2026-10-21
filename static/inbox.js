// Caixa de entrada: documentos recebidos → ação certa por tipo.
// Boleto / NF em PDF ou foto → leitor (Novo lançamento). NF-e XML → painel com itens e parcelas.
// Relatório de vendas → prévia (a leitura das vendas vem na próxima etapa).

const TIPO_DOC = {
  boleto: ['Boleto', 'doc-boleto'], nota_fiscal: ['Nota fiscal', 'doc-nf'],
  relatorio_vendas: ['Relatório de vendas', 'doc-rel'], outro: ['Outro', 'doc-outro'],
};
const ORIGEM_DOC = { upload: 'Upload', drive: 'Google Drive', whatsapp: 'WhatsApp', email: 'E-mail' };
const quando = s => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function atualizarBadgeInbox() {
  try {
    const r = await api('inbox/contagem');
    const b = document.getElementById('inbox-badge');
    if (b) { b.hidden = !r.novos; b.textContent = r.novos; }
  } catch (_) { /* opcional */ }
}

async function enviarDocumentos(arquivos) {
  const fd = new FormData();
  [...arquivos].forEach(a => fd.append('arquivos', a));
  const r = await fetch('/api/inbox', { method: 'POST', headers: { 'x-cockpit': '1' }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(erroDe(j, r.status));
  return j;
}

function acoesDoc(d) {
  const a = [];
  const nfXml = d.tipo === 'nota_fiscal' && d.subtipo === 'nfe_xml';
  if (d.status !== 'processado') {
    if (nfXml) a.push(`<button class="btn sm primary" data-nf="${d.id}">Ver nota e lançar</button>`);
    else if (d.tipo === 'boleto' || d.tipo === 'nota_fiscal') a.push(`<a class="btn sm primary" href="#/fin/novo?doc=${d.id}">Lançar conta a pagar</a>`);
  }
  if (nfXml && d.status === 'processado') a.push(`<button class="btn sm" data-nf="${d.id}">Ver nota</button>`);
  if (d.tipo === 'nota_fiscal') a.push(d.finalidade ? `<a class="btn sm" href="#/conciliar?doc=${d.id}" title="Não entra no estoque nem no preço">${esc(d.finalidade.split(' · ')[0])}</a>`
    : d.conciliada_em ? `<a class="btn sm" href="#/conciliar?doc=${d.id}">Itens conciliados ✓</a>`
    : `<a class="btn sm" href="#/conciliar?doc=${d.id}">Conciliar itens</a>`);
  if (d.tipo === 'relatorio_vendas') a.push(`<button class="btn sm" data-prev="${d.id}">Ver prévia</button>`);
  if (d.lancamento_ids?.length) a.push(`<a class="btn sm" href="#/fin/lancamento/${d.lancamento_ids[0]}">Ver lançamento${d.lancamento_ids.length > 1 ? `s (${d.lancamento_ids.length})` : ''}</a>`);
  if (d.tipo === 'outro' && d.status !== 'processado') a.push(`<button class="btn sm primary" data-enviar="${d.id}">Enviar para…</button>`);
  if (d.status === 'novo') a.push(`<button class="btn sm" data-st="processado" data-id="${d.id}" title="Já cuidei disso: tira da caixa de entrada (fica em Processados)">✓ Já resolvido</button>`);
  a.push(`<a class="ico-btn" href="/api/inbox/${d.id}/arquivo" target="_blank" rel="noopener" title="Abrir arquivo" aria-label="Abrir arquivo">↗</a>`);
  a.push(d.status === 'arquivado'
    ? `<button class="ico-btn" data-st="novo" data-id="${d.id}" title="Restaurar" aria-label="Restaurar">↺</button>`
    : `<button class="ico-btn" data-st="arquivado" data-id="${d.id}" title="Arquivar" aria-label="Arquivar">🗄</button>`);
  return a.join('');
}

PAGES['inbox'] = {
  eyebrow: 'Documentos', title: 'Caixa de entrada',
  lede: 'Boletos, notas fiscais e relatórios de vendas chegam aqui para virar lançamento.', periodo: false,
  async render(v, p) {
    const status = p.status || 'novo', tipo = p.tipo || '';
    const antigos = p.antigos === '1';
    const r = await api(`inbox?${new URLSearchParams({ status, tipo, ...(antigos ? { antigos: 'true' } : {}) })}`);
    const c = r.contagem;
    const flash = FLASH; FLASH = '';
    const ir = mudar => { location.hash = `#/inbox?${new URLSearchParams({ status, tipo, ...(antigos ? { antigos: '1' } : {}), ...mudar })}`; };
    v.innerHTML = `
      ${flash ? `<div class="alert ok">${flash}</div>` : ''}
      <label class="drop drop-h" id="inbox-drop">
        <input type="file" multiple hidden accept=".pdf,.xml,.csv,.xlsx,.txt,image/*,.heic">
        <span class="drop-ico">⇪</span>
        <span><b>Arraste documentos aqui</b> ou clique para escolher<br>
        <small>PDF, foto, XML de NF-e, planilha (CSV/Excel) · vários de uma vez · o tipo é identificado sozinho</small></span>
      </label>
      <div class="toolbar">
        <div class="tabs">
          ${[['novo', 'Novos'], ['processado', 'Processados'], ['arquivado', 'Arquivados'], ['todos', 'Todos']].map(([k, l]) =>
            `<button class="tab ${status === k ? 'on' : ''}" data-status="${k}">${l}${k !== 'todos' && c[k] ? ` <span class="cnt">${c[k]}</span>` : ''}</button>`).join('')}
        </div>
        <button class="btn sm" id="conf-nibo" title="Confere se as duplicatas das notas XML estão lançadas no Nibo">Conferir notas × Nibo</button>
        <div class="chips">${[['', 'Todos os tipos'], ['boleto', 'Boletos'], ['nota_fiscal', 'Notas fiscais'], ['relatorio_vendas', 'Relatórios de vendas'], ['outro', 'Outros']].map(([k, l]) =>
          `<button class="chip ${tipo === k ? 'on' : ''}" data-tipo="${k}">${l}</button>`).join('')}</div>
      </div>
      <div class="card doc-lista">
        ${r.documentos.map(d => {
          const [rot, cls] = TIPO_DOC[d.tipo] || TIPO_DOC.outro;
          return `<div class="doc-row">
            <span class="doc-tipo ${cls}">${rot}</span>
            <div class="doc-info"><b>${esc(d.resumo || d.nome)}</b>
              <small>${esc(d.nome)} · ${ORIGEM_DOC[d.origem] || d.origem} · ${quando(d.recebido_em)}${d.status === 'processado' ? ' · <span class="ok-txt">processado</span>' : ''}</small></div>
            <div class="doc-acoes">${acoesDoc(d)}</div></div>`;
        }).join('') || `<div class="empty">${status === 'novo' ? 'Nada novo por aqui. Arraste documentos acima.'
          : status === 'processado' && !antigos ? 'Nada processado nos últimos 30 dias.' : 'Nenhum documento neste filtro.'}</div>`}
      </div>
      ${r.ocultos ? `<div class="mais-antigos"><span class="muted small-txt">Mostrando os processados dos últimos 30 dias.</span>
        <button class="btn sm" id="inbox-antigos">Mostrar mais antigos (${r.ocultos})</button></div>` : ''}`;
    v.querySelector('#inbox-antigos')?.addEventListener('click', () => ir({ antigos: '1' }));

    v.querySelectorAll('[data-status]').forEach(b => b.onclick = () => ir({ status: b.dataset.status, antigos: '' }));
    v.querySelectorAll('[data-tipo]').forEach(b => b.onclick = () => ir({ tipo: b.dataset.tipo }));
    v.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => {
      await send('POST', `inbox/${b.dataset.id}/status`, { status: b.dataset.st });
      FLASH = { arquivado: 'Documento arquivado.', processado: 'Pronto, saiu da caixa de entrada (está em Processados).' }[b.dataset.st] || 'Documento restaurado para Novos.';
      atualizarBadgeInbox(); render();
    });
    v.querySelectorAll('[data-nf]').forEach(b => b.onclick = () => painelNfe(b.dataset.nf));
    v.querySelector('#conf-nibo').onclick = () => conferenciaNibo();
    v.querySelectorAll('[data-enviar]').forEach(b => b.onclick = () => enviarDocPara(r.documentos.find(d => d.id === b.dataset.enviar)));
    v.querySelectorAll('[data-prev]').forEach(b => b.onclick = () => previaRelatorio(b.dataset.prev));

    const drop = v.querySelector('#inbox-drop'), input = drop.querySelector('input');
    const subir = async arquivos => {
      if (!arquivos.length) return;
      drop.classList.add('lendo-h');
      drop.querySelector('b').textContent = `Lendo ${arquivos.length} arquivo(s)…`;
      try {
        const res = await enviarDocumentos(arquivos);
        const novos = res.filter(x => !x.duplicado && !x.erro), dup = res.filter(x => x.duplicado), err = res.filter(x => x.erro);
        FLASH = [novos.length ? `${novos.length} documento(s) recebido(s): ${novos.map(x => `<b>${esc((TIPO_DOC[x.tipo] || TIPO_DOC.outro)[0])}</b>`).join(', ')}.` : '',
                 dup.length ? `${dup.length} já estava(m) na caixa de entrada.` : '',
                 err.length ? `Com erro: ${err.map(x => esc(`${x.nome} (${x.erro})`)).join('; ')}.` : ''].filter(Boolean).join(' ');
        atualizarBadgeInbox();
        if (status !== 'novo') ir({ status: 'novo' }); else render();
      } catch (e) { alert(e.message); render(); }
    };
    input.onchange = () => subir(input.files);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); subir(e.dataTransfer.files); };
  },
};

// ---------------------------------------------------------------- documento não identificado: o usuário diz o que é
const DESTINOS_DOC = [
  ['curriculo', 'Currículo', 'Vai para RH › Candidatos, com o arquivo anexado'],
  ['boleto', 'Boleto', 'Fica na caixa de entrada para lançar em contas a pagar'],
  ['nota_fiscal', 'Nota fiscal', 'Fica na caixa de entrada para lançar e conciliar'],
  ['relatorio_vendas', 'Relatório de vendas', 'Fica na caixa de entrada como relatório'],
];
function enviarDocPara(d) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<div class="dlg-body"><h3>O que é este documento?</h3>
    <div class="sub">${esc(d.nome)} · <a href="/api/inbox/${d.id}/arquivo" target="_blank" rel="noopener">abrir o arquivo ↗</a></div>
    <div class="destinos">${DESTINOS_DOC.map(([k, rot, ajuda]) => `<button type="button" class="destino" data-dest="${k}"><b>${rot}</b><small>${ajuda}</small></button>`).join('')}</div>
    <div class="dlg-err" hidden></div>
    <div class="actions"><button type="button" class="btn" data-fechar>Cancelar</button></div></div>`;
  const err = dlg.querySelector('.dlg-err');
  dlg.onclick = async e => {
    if (e.target.closest('[data-fechar]')) return dlg.close();
    const b = e.target.closest('[data-dest]');
    if (!b) return;
    if (b.dataset.dest === 'curriculo') { dlg.close(); return painelCandidato(null, null, d); }
    try {
      await send('POST', `inbox/${d.id}/tipo`, { tipo: b.dataset.dest });
      dlg.close(); FLASH = `Marcado como ${esc(b.querySelector('b').textContent.toLowerCase())}.`; render();
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- notas XML × contas a pagar do Nibo (só leitura)
const SIT_CONF = {
  ok: ['ok-txt', '✓ lançada'], valor: ['warn-txt', '≠ valor diferente'], data: ['warn-txt', '≠ vencimento diferente'],
  nao_achei: ['neg', '✗ não achei no Nibo'], debito: ['muted', 'nota de débito (juros)'],
};
async function conferenciaNibo() {
  const dlg = document.getElementById('dlg');
  dlg.className = 'dlg xl';
  dlg.addEventListener('close', () => { dlg.className = 'dlg'; }, { once: true });
  dlg.innerHTML = '<div class="dlg-body"><div class="loading">Conferindo com o Nibo…</div></div>';
  dlg.showModal();
  let r;
  try { r = await api('inbox/conferencia-nibo'); } catch (e) { dlg.innerHTML = `<div class="dlg-body"><div class="alert err">${esc(e.message)}</div><form method="dialog"><button class="btn">Fechar</button></form></div>`; return; }
  const ordem = { nao_achei: 0, valor: 1, data: 2, ok: 3, debito: 4 };
  const itens = [...r.itens].sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || a.fornecedor.localeCompare(b.fornecedor) || (a.vencimento || '').localeCompare(b.vencimento || ''));
  const filtro = sit => itens.filter(e => !sit || e.situacao === sit);
  const tabela = lista => `<div class="table-wrap"><table class="cn-tab"><thead><tr><th>Nota</th><th>Fornecedor</th><th>Parcela</th><th class="n">Valor no XML</th><th>Vencimento</th><th>No Nibo</th></tr></thead><tbody>
    ${lista.map(e => {
      const [cls, rot] = SIT_CONF[e.situacao];
      return `<tr><td>NF ${esc(e.nf)}<small>emitida ${dm(e.emissao)}</small></td><td>${esc(e.fornecedor)}</td><td>${e.parcela || '<span class="muted">sem duplicata</span>'}</td>
        <td class="n">${money(e.valor)}</td><td>${e.vencimento ? dm(e.vencimento) : '—'}</td>
        <td><span class="${cls}">${rot}</span>${e.nibo ? `<small>${money(e.nibo.valor)} · venc. ${dm(e.nibo.vencimento)} · ${e.nibo.status === 'pago' ? 'pago' : 'em aberto'}${e.nibo.origem !== 'nibo' ? ' · lançado no app' : ''}</small>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">Nada aqui.</td></tr>'}</tbody></table></div>`;
  const rs = r.resumo;
  dlg.innerHTML = `<div class="dlg-body">
    <div class="hist-head"><div><h3>Notas XML × contas a pagar do Nibo</h3>
      <div class="sub">Cada duplicata do XML é procurada no Nibo pelo fornecedor (CNPJ), valor e vencimento (até ${5} dias de diferença). Só leitura.</div></div>
      <form method="dialog"><button class="btn sm">Fechar</button></form></div>
    <div class="tit-tabs cn-abas" role="tablist">
      ${[['', 'Todas', itens.length], ['nao_achei', 'Não achei', rs.nao_achei], ['valor', 'Valor diferente', rs.valor + rs.data], ['ok', 'Lançadas', rs.ok], ['debito', 'Notas de débito', rs.debito]]
        .map(([k, rot, n], i) => `<button type="button" class="${i === 1 ? 'on' : ''}" data-sit="${k}">${rot} <b class="${k === 'nao_achei' && n ? 'neg' : ''}">${n}</b></button>`).join('')}
    </div>
    <div id="cn-lista">${tabela(filtro('nao_achei'))}</div>
    ${r.sobras.length ? `<details class="cn-sobras"><summary>${r.sobras.length} conta(s) desses fornecedores no Nibo sem nota XML correspondente</summary>
      <p class="muted small-txt">Boleto de nota que não chegou em XML, nota agrupada em um boleto só, ou parcela com valor diferente.</p>
      <div class="table-wrap"><table><thead><tr><th>Fornecedor</th><th>Vencimento</th><th class="n">Valor</th><th>Situação</th><th>Descrição</th></tr></thead><tbody>
      ${r.sobras.map(s => `<tr><td>${esc(s.contato || '')}</td><td>${dm(s.vencimento)}</td><td class="n">${money(s.valor)}</td><td>${s.status === 'pago' ? 'pago' : 'em aberto'}</td><td class="muted small-txt">${esc((s.descricao || '').slice(0, 80))}</td></tr>`).join('')}
      </tbody></table></div></details>` : ''}
  </div>`;
  dlg.querySelectorAll('[data-sit]').forEach(b => b.onclick = () => {
    dlg.querySelectorAll('[data-sit]').forEach(x => x.classList.toggle('on', x === b));
    dlg.querySelector('#cn-lista').innerHTML = tabela(b.dataset.sit === 'valor' ? itens.filter(e => e.situacao === 'valor' || e.situacao === 'data') : filtro(b.dataset.sit));
  });
}

// ---------------------------------------------------------------- prévia de relatório
async function previaRelatorio(id) {
  const d = await api(`inbox/${id}`);
  const prev = d.dados?.previa;
  const dlg = document.getElementById('dlg');
  dlg.className = 'dlg xl';
  dlg.addEventListener('close', () => { dlg.className = 'dlg'; }, { once: true });
  dlg.innerHTML = `<div class="dlg-body">
    <div class="hist-head"><div><h3>${esc(d.nome)}</h3><div class="sub">${esc(d.resumo || '')}</div></div>
      <form method="dialog"><button class="btn sm">Fechar</button></form></div>
    ${prev ? `<div class="table-wrap"><table><thead><tr>${prev.colunas.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${prev.linhas.map(l => `<tr>${l.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="muted small-txt">Mostrando as primeiras ${prev.linhas.length} de ${prev.total_linhas} linhas. A leitura das vendas (itens, pedidos, clientes) entra na próxima etapa.</p>`
      : '<p class="muted">Relatório em PDF: sem prévia em tabela. <a href="/api/inbox/' + id + '/arquivo" target="_blank" rel="noopener">Abrir o arquivo</a>.</p>'}
    <div class="actions"><button class="btn" data-proc>Marcar como processado</button></div>
  </div>`;
  dlg.querySelector('[data-proc]').onclick = async () => {
    await send('POST', `inbox/${id}/status`, { status: 'processado' });
    dlg.close(); FLASH = 'Relatório marcado como processado.'; atualizarBadgeInbox(); render();
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- NF-e (XML): itens + parcelas → contas a pagar
async function painelNfe(id) {
  await finOpcoes();
  const d = await api(`inbox/${id}`);
  const nf = d.dados.nfe;
  const lancada = d.no_financeiro || d.status === 'processado';
  let dr = document.getElementById('drawer');
  if (!dr) { dr = document.createElement('dialog'); dr.id = 'drawer'; dr.className = 'drawer'; document.body.appendChild(dr); }
  dr.classList.add('largo');
  const parcelas = nf.parcelas.length ? nf.parcelas.map(p => ({ vencimento: p.vencimento, valor: Number(p.valor) }))
    : [{ vencimento: nf.emissao, valor: Number(nf.valor_total) }];
  const catPadrao = FIN_OPCOES.categorias.find(c => c.categoria === 'Fornecedores de insumos para cozinha')?.id;
  const emit = nf.emitente;
  const cnpjFmt = (emit.cnpj || '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  const linhaParcela = (p, i) => `<div class="parc-row">
      <span class="muted">${i + 1}</span>
      <input type="date" value="${p.vencimento || ''}" data-pv required>
      <input class="money" inputmode="decimal" value="${fmtMoeda(p.valor)}" data-pval required>
      ${lancada ? '' : '<button type="button" class="ico-btn" data-rmp aria-label="Remover parcela">×</button>'}</div>`;
  dr.innerHTML = `<form class="drawer-body" autocomplete="off">
    <div class="drawer-head"><h3>NF ${esc(nf.numero)}${nf.serie ? ` · série ${esc(nf.serie)}` : ''}</h3><button type="button" class="btn sm" data-fechar aria-label="Fechar">✕</button></div>
    <div class="drawer-campos nf-campos">
      <div class="span2 nf-cab">
        <div><small>Emitente</small><b>${esc(emit.fantasia || emit.nome)}</b><span class="muted">${esc(emit.nome)} · ${cnpjFmt}</span></div>
        <div><small>Emissão</small><b>${nf.emissao ? dm(nf.emissao) + '/' + nf.emissao.slice(0, 4) : '—'}</b><span class="muted">${esc(nf.natureza || '')}</span></div>
        <div><small>Total da nota</small><b>${money(nf.valor_total)}</b><span class="muted">${nf.itens.length} itens${Number(nf.valor_frete) ? ` · frete ${money(nf.valor_frete)}` : ''}</span></div>
      </div>
      ${lancada ? '<div class="span2 alert ok small">Esta nota já foi lançada em contas a pagar. Os itens estão guardados para o CMV.</div>' : ''}
      <div class="span2"><div class="campo-rot">Itens da nota</div>
        <div class="table-wrap nf-itens"><table><thead><tr><th>Produto</th><th class="n">Qtd</th><th>Un</th><th class="n">Unitário</th><th class="n">Total</th></tr></thead>
        <tbody>${nf.itens.map(i => `<tr><td title="${esc(i.descricao)}">${esc(i.descricao)}</td><td class="n">${num1.format(Number(i.quantidade))}</td>
          <td>${esc(i.unidade)}</td><td class="n">${fmtMoeda(Number(i.valor_unitario))}</td><td class="n">${fmtMoeda(Number(i.valor_total))}</td></tr>`).join('')}</tbody></table></div></div>
      ${lancada ? '' : `
      <div class="campo span2"><span class="campo-rot">Fornecedor</span>${pickerPessoa(d.emitente_cadastrado?.id || null, '')}
        ${d.emitente_cadastrado ? '' : `<button type="button" class="btn sm" data-cademit>＋ Cadastrar ${esc(emit.fantasia || emit.nome)} (CNPJ da nota)</button>`}</div>
      <label>Categoria<select name="categoria_id">${categoriaOptions('pagar', catPadrao)}</select></label>
      <label>Conta bancária (opcional)<select name="conta_id"><option value="">Selecione…</option>${FIN_OPCOES.contas.map(c => `<option value="${c.id}">${esc(c.conta)}</option>`).join('')}</select></label>
      <label class="span2">Descrição<input name="descricao" maxlength="300" value="${esc(`NF ${nf.numero} - ${emit.fantasia || emit.nome}`)}"></label>
      <div class="span2"><div class="campo-rot">Parcelas (contas a pagar) <span class="muted">· ${nf.parcelas.length ? 'vindas da nota' : 'a nota não tem duplicatas: uma parcela à vista'}</span></div>
        <div id="parcelas">${parcelas.map(linhaParcela).join('')}</div>
        <button type="button" class="btn sm" data-addp>＋ Parcela</button>
        <div class="parc-tot" id="parc-tot"></div></div>`}
    </div>
    <div class="dlg-err" hidden></div>
    <div class="drawer-foot">
      <div><small>Total da nota</small><b>${fmtMoeda(Number(nf.valor_total))}</b></div>
      <div class="actions"><a class="btn" href="#/conciliar?doc=${id}">${d.compra?.[0]?.finalidade ? `${esc(d.compra[0].finalidade)} (não entra no estoque)` : d.compra?.[0]?.conciliada_em ? 'Itens conciliados ✓' : 'Conciliar itens (estoque e preços)'}</a>
        <button type="button" class="btn" data-fechar>${lancada ? 'Fechar' : 'Cancelar'}</button>
        ${lancada ? '' : '<button class="btn primary" id="lancar-nf">Lançar contas a pagar</button>'}</div>
    </div>
  </form>`;
  const f = dr.querySelector('form');
  dr.querySelectorAll('[data-fechar]').forEach(b => b.onclick = () => dr.close());
  dr.addEventListener('close', () => dr.classList.remove('largo'), { once: true });
  if (!lancada) {
    const picker = f.querySelector('[data-picker]');
    ligarPicker(picker);
    const total = () => {
      const vals = [...f.querySelectorAll('[data-pval]')].map(i => lerMoeda(i.value) || 0);
      const soma = Math.round(vals.reduce((s, x) => s + x, 0) * 100) / 100;
      const dif = Math.round((soma - Number(nf.valor_total)) * 100) / 100;
      f.querySelector('#parc-tot').innerHTML = `${vals.length} parcela(s) · soma ${money(soma)}${dif ? ` · <span class="neg">difere da nota em ${money(dif)}</span>` : ' · <span class="ok-txt">bate com a nota ✓</span>'}`;
      f.querySelector('#lancar-nf').textContent = `Lançar ${vals.length} conta(s) a pagar`;
    };
    f.addEventListener('input', total);
    f.querySelector('[data-addp]').onclick = () => {
      f.querySelector('#parcelas').insertAdjacentHTML('beforeend', linhaParcela({ vencimento: '', valor: '' }, f.querySelectorAll('.parc-row').length));
      total();
    };
    f.querySelector('#parcelas').onclick = e => { if (e.target.closest('[data-rmp]') && f.querySelectorAll('.parc-row').length > 1) { e.target.closest('.parc-row').remove(); total(); } };
    f.querySelector('[data-cademit]')?.addEventListener('click', () => dialogoCad({
      titulo: 'Novo fornecedor', campos: camposPessoa('financeiro'),
      valores: { nome: emit.nome, documento: emit.cnpj, tipo_pessoa: emit.cnpj?.length === 14 ? 'PJ' : 'PF', papeis: ['fornecedor'], tipo_fornecedor: 'insumos' },
      salvar: x => send('POST', 'cad/pessoas', x),
      depois: nova => { FIN_OPCOES.pessoas.push(nova); picker.porNome(nova.nome); f.querySelector('[data-cademit]')?.remove(); },
    }));
    total();
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const err = dr.querySelector('.dlg-err'); err.hidden = true;
      try {
        if (!f.contato_id.value) throw new Error('Escolha ou cadastre o fornecedor');
        const parcs = [...f.querySelectorAll('.parc-row')].map(r => ({ vencimento: r.querySelector('[data-pv]').value, valor: lerMoeda(r.querySelector('[data-pval]').value) }));
        if (parcs.some(x => !x.vencimento || !(x.valor > 0))) throw new Error('Preencha vencimento e valor de todas as parcelas');
        const r = await send('POST', `inbox/${id}/lancar-nfe`, {
          contato_id: f.contato_id.value, categoria_id: f.categoria_id.value || null, conta_id: f.conta_id.value || null,
          descricao: f.descricao.value.trim() || null, parcelas: parcs });
        dr.close();
        FLASH = `NF ${esc(nf.numero)} lançada: ${r.lancamentos.length} conta(s) a pagar e ${nf.itens.length} itens guardados para o CMV.`;
        FIN_OPCOES = null; atualizarBadgeInbox(); render();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    });
  }
  dr.showModal();
}
