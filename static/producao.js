// Fichas de produção: a equipe consulta (e imprime) quantidades e modo de preparo — sem custos.
// Servidor: producao.py (/api/portal/fichas, qualquer login).

const fmtQ = v => fmtQtd(Math.round(Number(v) * 1000) / 1000);
const MULT = [0.5, 1, 2, 3, 4];

PAGES['producao'] = {
  eyebrow: 'Cozinha', title: 'Fichas de produção', lede: 'Quantidades e modo de preparo de cada receita.', periodo: false,
  async render(v, p) {
    if (p.dono && p.id) return fichaProducao(v, p.dono, p.id);
    const r = await api('portal/fichas');
    const aba = p.aba === 'produtos' ? 'produtos' : 'manufaturados';
    const lista = r[aba];
    const grupos = {};
    lista.forEach(x => (grupos[x.categoria] ||= []).push(x));
    v.innerHTML = `
      <div class="toolbar">
        <div class="tabs">
          <button class="tab ${aba === 'manufaturados' ? 'on' : ''}" data-aba="manufaturados">Manufaturados (preparos) <span class="cnt">${r.manufaturados.length}</span></button>
          <button class="tab ${aba === 'produtos' ? 'on' : ''}" data-aba="produtos">Produtos do cardápio <span class="cnt">${r.produtos.length}</span></button>
        </div>
        <input id="pr-q" class="pr-busca" placeholder="Buscar receita…" autocomplete="off">
      </div>
      ${Object.entries(grupos).map(([g, xs]) => `<div class="card pr-grupo"><h3>${esc(g)}</h3><div class="pr-lista">
        ${xs.map(x => `<a class="pr-item" data-busca="${esc(normBusca(x.nome))}" href="#/producao?dono=${aba === 'produtos' ? 'produto' : 'manufaturado'}&id=${x.id}">
          <b>${esc(x.nome)}</b><small>${x.itens} ingredientes${x.rendimento ? ` · rende ${fmtQ(x.rendimento)} ${esc(x.unidade)}${aba === 'produtos' && Number(x.rendimento) !== 1 ? 's' : ''}` : ''}${x.tem_preparo ? '' : ' · <span class="muted">sem modo de preparo</span>'}</small></a>`).join('')}
      </div></div>`).join('') || '<div class="empty">Nenhuma ficha técnica cadastrada ainda.</div>'}`;
    v.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { location.hash = `#/producao?aba=${b.dataset.aba}`; });
    v.querySelector('#pr-q').oninput = e => {
      const t = normBusca(e.target.value.trim());
      v.querySelectorAll('.pr-item').forEach(a => { a.hidden = t && !a.dataset.busca.includes(t); });
      v.querySelectorAll('.pr-grupo').forEach(g => { g.hidden = ![...g.querySelectorAll('.pr-item')].some(a => !a.hidden); });
    };
  },
};

async function fichaProducao(v, dono, id) {
  const f = await api(`portal/fichas/${dono}/${id}`);
  document.getElementById('title').textContent = f.nome;
  let mult = 1, editando = false;
  const rendeRot = m => f.rendimento ? `${fmtQ(f.rendimento * m)} ${f.unidade}${dono === 'produto' && f.rendimento * m !== 1 ? 's' : ''}` : '—';
  const linhas = m => f.itens.map(i => `<tr>
      <td>${i.tipo === 'manufaturado' ? `<a href="#/producao?dono=manufaturado&id=${i.id}">${esc(i.nome)}</a> <small class="muted">preparo</small>` : esc(i.nome)}</td>
      <td class="n"><b>${fmtQ(i.quantidade * m)}</b></td><td>${esc(i.unidade)}</td>
      <td class="muted small-txt">${Number(i.perda_pct) ? `perda ${fmtQ(i.perda_pct)}%` : ''}</td></tr>`).join('');
  const fotoUrl = () => `/api/portal/fichas/${dono}/${id}/foto?v=${encodeURIComponent(f.foto_em || '')}`;
  const desenhar = () => {
    v.innerHTML = `
      <p><a href="#/producao?aba=${dono === 'produto' ? 'produtos' : 'manufaturados'}" class="link-btn">← Todas as fichas</a></p>
      <div class="card pr-ficha">
        <div class="pr-topo"><div><div class="eyebrow">${esc(f.categoria)}</div><h2>${esc(f.nome)}</h2>
          ${f.descricao ? `<p class="sub">${esc(f.descricao)}</p>` : ''}</div>
          <button class="btn" id="pr-imp">🖨 Imprimir</button></div>
        ${f.foto_em || ehAdmin() ? `<div class="pr-foto">
          ${f.foto_em ? `<a href="${fotoUrl()}" target="_blank" rel="noopener" title="Abrir a foto"><img src="${fotoUrl()}" alt="Como fica pronto: ${esc(f.nome)}"></a>`
            : '<div class="pr-foto-vazia">Sem foto de como fica pronto</div>'}
          ${ehAdmin() ? `<div class="pr-foto-acoes"><label class="btn sm">📷 ${f.foto_em ? 'Trocar foto' : 'Adicionar foto'}<input type="file" id="pr-foto-in" accept="image/*" hidden></label>
            ${f.foto_em ? '<button class="btn sm" id="pr-foto-rm">Remover</button>' : ''}<span class="muted small-txt" id="pr-foto-st"></span></div>` : ''}
        </div>` : ''}
        <div class="pr-mult"><span>Quantas receitas?</span>${MULT.map(m => `<button class="chip ${m === mult ? 'on' : ''}" data-m="${m}">${m === 0.5 ? '½' : `${m}×`}</button>`).join('')}
          <label>ou <input id="pr-m" inputmode="decimal" value="${MULT.includes(mult) ? '' : fmtQtd(mult)}" placeholder="ex.: 1,5"> ×</label>
          <span class="pr-rende">Rende <b>${rendeRot(mult)}</b></span></div>
        <h3>Ingredientes</h3>
        <div class="table-wrap"><table class="pr-tab"><thead><tr><th>Ingrediente</th><th class="n">Quantidade</th><th>Unid.</th><th></th></tr></thead>
          <tbody>${linhas(mult)}</tbody></table></div>
        <div class="pr-prep-h"><h3>Modo de preparo</h3>${ehAdmin() && !editando ? `<button class="btn sm" id="pr-edit">✎ ${f.modo_preparo ? 'Editar' : 'Escrever'}</button>` : ''}</div>
        ${editando ? `<textarea id="pr-txt" rows="12" maxlength="8000" placeholder="1. Separe os ingredientes…&#10;2. …&#10;Montagem / apresentação, tempo, ponto, validade, armazenamento…">${esc(f.modo_preparo || '')}</textarea>
            <div class="dlg-err" hidden></div>
            <div class="actions"><button class="btn" id="pr-cancel">Cancelar</button><button class="btn primary" id="pr-salvar">Salvar modo de preparo</button></div>`
          : f.modo_preparo ? `<div class="pr-preparo">${esc(f.modo_preparo)}</div>`
          : `<p class="muted">Ainda sem modo de preparo.</p>`}
      </div>`;
    v.querySelector('#pr-edit')?.addEventListener('click', () => { editando = true; desenhar(); v.querySelector('#pr-txt').focus(); });
    v.querySelector('#pr-cancel')?.addEventListener('click', () => { editando = false; desenhar(); });
    v.querySelector('#pr-salvar')?.addEventListener('click', async () => {
      const txt = v.querySelector('#pr-txt').value;
      try {
        await send('PUT', `fichas/${dono}/${id}/preparo`, { modo_preparo: txt });
        f.modo_preparo = txt.trim() || null; editando = false; desenhar();
      } catch (ex) { const er = v.querySelector('.dlg-err'); er.hidden = false; er.textContent = ex.message; }
    });
    v.querySelector('#pr-foto-in')?.addEventListener('change', async e => {
      const arq = e.target.files[0]; if (!arq) return;
      const st = v.querySelector('#pr-foto-st'); st.textContent = 'Enviando…';
      const fd = new FormData(); fd.append('arquivo', arq);
      try {
        const r = await fetch(`/api/fichas/${dono}/${id}/foto`, { method: 'POST', headers: { 'x-cockpit': '1' }, body: fd });
        if (!r.ok) throw new Error(erroDe(await r.json().catch(() => ({})), r.status));
        f.foto_em = new Date().toISOString(); desenhar();
      } catch (ex) { st.textContent = ex.message; }
    });
    v.querySelector('#pr-foto-rm')?.addEventListener('click', async () => {
      if (!confirm('Remover a foto desta ficha?')) return;
      try { await send('DELETE', `fichas/${dono}/${id}/foto`); f.foto_em = null; desenhar(); } catch (ex) { alert(ex.message); }
    });
    v.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mult = Number(b.dataset.m); desenhar(); });
    v.querySelector('#pr-m').onchange = e => { const m = lerQtd(e.target.value); if (m > 0) { mult = m; desenhar(); } };
    v.querySelector('#pr-imp').onclick = () => imprimirDoc(`Ficha de produção — ${f.nome}`, `
      <div class="p-cab">__LOGO__<div><h1>${esc(f.nome)}</h1><small>${esc(nomeEmpresa())} · Ficha de produção · ${esc(f.categoria)}${mult !== 1 ? ` · receita ×${fmtQtd(mult)}` : ''}</small></div></div>
      ${f.foto_em ? `<img class="p-foto" src="${location.origin}${fotoUrl()}" alt="">` : ''}
      <p><b>Rende:</b> ${rendeRot(mult)}</p>
      ${f.descricao ? `<p>${esc(f.descricao)}</p>` : ''}
      <h2>Ingredientes</h2>
      <table><thead><tr><th>Ingrediente</th><th class="n">Quantidade</th><th>Unid.</th><th></th></tr></thead><tbody>
      ${f.itens.map(i => `<tr><td>${esc(i.nome)}${i.tipo === 'manufaturado' ? ' <small>(preparo — ver ficha)</small>' : ''}</td>
        <td class="n"><b>${fmtQ(i.quantidade * mult)}</b></td><td>${esc(i.unidade)}</td><td>${Number(i.perda_pct) ? `perda ${fmtQ(i.perda_pct)}%` : ''}</td></tr>`).join('')}
      </tbody></table>
      <h2>Modo de preparo</h2>
      ${f.modo_preparo ? `<div class="p-preparo">${esc(f.modo_preparo)}</div>` : '<p>—</p>'}
      <p class="p-rod">Impresso em ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}. Em caso de dúvida, a versão do app é a que vale.</p>`);
  };
  desenhar();
}
