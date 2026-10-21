// Portal do funcionário (pensado para celular): bater ponto com foto e localização, espelho do mês,
// vales/consumos a descontar, pagamentos recebidos e holerites. Só mostra dados da própria pessoa.

function localizacao() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => res(p.coords), () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
  });
}

PAGES['portal'] = {
  eyebrow: 'Meu portal', title: 'Olá!', lede: 'Seu ponto, seus pagamentos e seus documentos.', periodo: false,
  async render(v, p) {
    const eu = await api('portal/eu');
    document.getElementById('title').textContent = `Olá, ${eu.nome.split(' ')[0]}!`;
    if (!eu.ficha) {
      v.innerHTML = `<div class="card empty">Seu login ainda não está ligado a uma ficha de funcionário.
        ${ehAdmin() ? 'Para usar o portal, cadastre-se em RH → Funcionários com o seu CPF.' : 'Fale com o administrador.'}</div>`;
      return;
    }
    const mes = p.mes || mesAtual();
    const [esp, res] = await Promise.all([api(`portal/ponto?mes=${mes}`), api(`portal/resumo?mes=${mes}`)]);
    const descontos = res.lancamentos.filter(l => l.tipo !== 'bonus');
    const totDesc = descontos.reduce((s, l) => s + l.valor, 0);
    const bonus = res.lancamentos.filter(l => l.tipo === 'bonus').reduce((s, l) => s + l.valor, 0);
    const totPago = res.pagamentos.reduce((s, x) => s + x.valor_pago, 0);
    const prox = eu.proxima_batida;
    api('portal/afazeres/contagem').then(a => {   // atalho para os afazeres (preenchido depois de desenhar)
      const el = document.getElementById('portal-afazeres');
      if (el && a.n) { el.hidden = false; el.innerHTML = `<b>Sua lista de tarefas</b><span>${a.n} para fazer →</span>`; }
    }).catch(() => {});
    const flash = FLASH; FLASH = '';
    v.innerHTML = `
      ${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      <a class="card portal-afazeres" href="#/afazeres" id="portal-afazeres" hidden></a>
      ${(USUARIO.estoque_setores || []).length ? `<a class="card portal-estoque" href="#/estoque?aba=contagem">
        <b>Contagem de estoque</b><span>${USUARIO.estoque_setores.map(s => SETOR_ROT[s]).join(' e ')} · ver o que contar hoje →</span></a>` : ''}
      <div class="portal-grid">
        <div class="card ponto-card">
          <div class="muted small-txt">${esc(eu.ficha.cargo || '')}${eu.ficha.cargo ? ' · ' : ''}${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}</div>
          <div class="relogio" id="relogio"></div>
          <button class="btn primary bater ${prox}" id="bater">${prox === 'entrada' ? '↘ Registrar entrada' : '↗ Registrar saída'}</button>
          <input type="file" accept="image/*" capture="user" id="foto-ponto" hidden>
          <div class="muted small-txt">Abre a câmera para uma foto rápida e registra a localização. A hora é a do servidor.</div>
          <div class="hoje">${eu.hoje.length ? eu.hoje.map(b => `<span class="batida ${b.tipo}">${b.tipo === 'entrada' ? '↘ Entrada' : '↗ Saída'} ${b.hora}${b.origem === 'ajuste' ? ' <em>ajuste</em>' : ''}</span>`).join('')
            : '<span class="muted small-txt">Nenhuma batida hoje.</span>'}</div>
          <div class="dlg-err" id="ponto-err" hidden></div>
        </div>
        ${USUARIO.perfil === 'responsavel_caixa' || ehAdmin() ? `<a class="card atalho" href="#/caixa"><b>Fechamento de caixa →</b><span class="muted small-txt">Feche o caixa do dia por aqui.</span></a>` : ''}
      </div>
      <div class="card"><div class="graf-head"><h3>Meu mês</h3>${navMes(mes)}</div>
        <div class="grid g3">
          ${kpi('Horas trabalhadas', horasMin(esp.total_minutos), `${esp.dias_trabalhados} dia(s)`)}
          ${kpi('A descontar', `<span class="${totDesc ? 'neg' : ''}">${money(totDesc)}</span>`, `${descontos.length} lançamento(s)${bonus ? ` · bônus ${money(bonus)}` : ''}`)}
          ${kpi('Recebido no mês', money(totPago), `${res.pagamentos.length} pagamento(s)`)}
        </div></div>
      <div class="grid g-1-1">
        <div class="card"><h3>Vales, consumos e descontos</h3>
          ${table([{ t: 'Data', f: l => dm(l.data) }, { t: 'Tipo', f: l => TIPO_LANC_RH[l.tipo] }, { t: 'Descrição', f: l => esc(l.descricao || '') },
                   { t: 'Valor', n: 1, f: l => `${l.tipo === 'bonus' ? '+' : '−'} ${money(l.valor)}` },
                   { t: '', f: l => l.status === 'descontado' ? '<small class="ok-txt">descontado</small>' : '' }], res.lancamentos)
            .replace('<tbody></tbody>', '<tbody><tr><td colspan="5" class="muted">Nada neste mês.</td></tr></tbody>')}</div>
        <div class="card"><h3>Pagamentos recebidos</h3>
          ${table([{ t: 'Data', f: x => dm(x.data_pagamento) }, { t: 'Descrição', f: x => esc(x.descricao || x.categoria_nome || '') },
                   { t: 'Valor', n: 1, f: x => money(x.valor_pago) }], res.pagamentos)
            .replace('<tbody></tbody>', '<tbody><tr><td colspan="3" class="muted">Nenhum pagamento registrado neste mês.</td></tr></tbody>')}</div>
      </div>
      <div class="card"><h3>Holerites e documentos</h3>
        <div class="docs-portal">${res.documentos.map(d => `<a class="doc-portal" href="/api/portal/documentos/${d.id}/arquivo" target="_blank" rel="noopener">
            <span>${TIPO_DOC_RH[d.tipo]}${d.competencia ? ` · ${rotMes(d.competencia.slice(0, 7))}` : ''}</span>${d.visto_em ? '' : '<span class="badge manual">novo</span>'}</a>`).join('')
          || '<span class="muted small-txt">Nenhum documento ainda.</span>'}</div></div>
      <div class="card"><h3>Espelho de ponto</h3>
        ${table([{ t: 'Dia', f: d => dmw(d.data) },
                 { t: 'Batidas', f: d => d.batidas.map(b => `${b.tipo === 'entrada' ? '↘' : '↗'} ${b.local.slice(11, 16)}`).join(' · ') },
                 { t: 'Horas', n: 1, f: d => d.minutos ? horasMin(d.minutos) : '—' },
                 { t: '', f: d => d.alerta ? `<small class="neg">${esc(d.alerta)}</small>` : '' }], esp.dias)
          .replace('<tbody></tbody>', '<tbody><tr><td colspan="4" class="muted">Nenhuma batida neste mês.</td></tr></tbody>')}</div>`;

    const rel = v.querySelector('#relogio');
    const tic = () => { if (document.body.contains(rel)) { rel.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); setTimeout(tic, 15000); } };
    tic();
    v.querySelectorAll('[data-mesrh]').forEach(b => b.onclick = () => { location.hash = `#/portal?mes=${b.dataset.mesrh}`; });
    const input = v.querySelector('#foto-ponto'), btn = v.querySelector('#bater'), err = v.querySelector('#ponto-err');
    btn.onclick = () => { err.hidden = true; input.click(); };
    input.onchange = async () => {
      if (!input.files[0]) return;
      btn.disabled = true; btn.textContent = 'Registrando…';
      try {
        const pos = await localizacao();
        const fd = new FormData();
        fd.append('foto', input.files[0]);
        if (pos) { fd.append('lat', pos.latitude); fd.append('lng', pos.longitude); fd.append('precisao', pos.accuracy); }
        const r = await fetch('/api/portal/ponto', { method: 'POST', headers: { 'x-cockpit': '1' }, body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(erroDe(j, r.status));
        FLASH = `${j.tipo === 'entrada' ? 'Entrada' : 'Saída'} registrada às ${j.hora}.${pos ? '' : ' (sem localização: permita o acesso à localização no navegador)'}`;
        render();
      } catch (e) { err.hidden = false; err.textContent = e.message; btn.disabled = false; btn.textContent = prox === 'entrada' ? '↘ Registrar entrada' : '↗ Registrar saída'; }
    };
  },
};
