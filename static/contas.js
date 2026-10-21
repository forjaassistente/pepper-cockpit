// Fluxo de caixa → Resumo (saldo por conta, realizado + projetado, próximos títulos)
// e Contas e extratos (extrato do mês, projeção da conta, novo pagamento/recebimento/transferência).

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotMes = ym => `${MESES_ABREV[Number(ym.slice(5, 7)) - 1]}/${ym.slice(0, 4)}`;
const somaMes = (ym, n) => { const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1); return iso(d).slice(0, 7); };
const diasEntre = (ini, fim) => { const out = []; const d = parseD(ini); const f = parseD(fim); while (d <= f) { out.push(iso(d)); d.setDate(d.getDate() + 1); } return out; };

let CONTAS_SEL = null;
try { CONTAS_SEL = JSON.parse(localStorage.getItem('cockpit.contasSel')); } catch (_) { /* sem storage */ }

// Gráfico de saldo: linha cheia até hoje, tracejada depois (projeção).
function graficoSaldo(el, dias, valores, hoje) {
  const idxHoje = dias.findIndex(d => d >= hoje);
  const corte = idxHoje === -1 ? dias.length - 1 : idxHoje;
  const real = valores.map((v, i) => (i <= corte ? v : null));
  const proj = valores.map((v, i) => (i >= corte && idxHoje !== -1 ? v : null));
  charts.push(new Chart(el, {
    type: 'line',
    data: {
      labels: dias.map(d => dm(d)),
      datasets: [
        { label: 'Realizado', data: real, borderColor: COL.saldo, backgroundColor: COL.saldo + '1F', fill: 'origin', borderWidth: 1.25, pointRadius: 0, pointHoverRadius: 4, tension: .25, spanGaps: false },
        { label: 'Projetado', data: proj, borderColor: COL.saldo, backgroundColor: COL.saldo + '0D', fill: 'origin', borderWidth: 1.25, borderDash: [4, 4], pointRadius: 0, pointHoverRadius: 4, tension: .25 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { ...tooltipBRL, callbacks: { ...tooltipBRL.callbacks, label: c => c.raw == null ? null : ` ${c.dataset.label}: ${money(c.raw)}`, footer: () => '' }, filter: c => c.raw != null } },
      scales: {
        x: { grid: { display: false }, border: { color: C('line') }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { grid: { color: '#EAF1F8' }, border: { display: false }, ticks: { callback: moneyTick, maxTicksLimit: 6 } },
      },
    },
  }));
}

const linhasTitulos = itens => itens.map(t => `<div class="tit-row">
    <span class="tit-d ${t.vencido ? 'neg' : ''}">${dm(t.vencimento)}/${t.vencimento.slice(2, 4)}</span>
    <span class="tit-n">${t.origem === 'manual' ? `<a href="#/fin/lancamento/${t.id}">${esc(t.contato || '—')}</a>` : esc(t.contato || '—')}
      <small>${esc(t.descricao || t.categoria_nome || '')}</small></span>
    <span class="tit-v">${money(t.valor_em_aberto)}</span></div>`).join('') || '<div class="empty">Nada por aqui.</div>';

function listaTitulos(tit, tipo) {
  const verbo = tipo === 'receber' ? 'receber' : 'pagar';
  return `<div class="card tit-card" data-tit="${tipo}">
    <h3 class="tit-h ${tipo}">${tipo === 'receber' ? '↑ Recebimentos' : '↓ Pagamentos'}</h3>
    <div class="tit-tabs" role="tablist">
      <button type="button" class="on" data-f="proximos" role="tab" aria-selected="true">Próximos a ${verbo}</button>
      <button type="button" data-f="aberto" role="tab" aria-selected="false">Em aberto <b>${money(tit.em_aberto)}</b></button>
      <button type="button" data-f="vencidos" role="tab" aria-selected="false">Vencido <b class="${tit.vencido ? 'neg' : ''}">${money(tit.vencido)}</b></button>
    </div>
    <div class="tit-list">${linhasTitulos(tit.proximos)}</div>
    <a class="tit-mais" data-mais href="#/fin/contas?tipo=${tipo}&status=aberto&p=90">Ver todos →</a>
  </div>`;
}

PAGES['fin/resumo'] = {
  eyebrow: 'Fluxo de caixa', title: 'Resumo do caixa', lede: 'Saldo das contas, o que já aconteceu e o que vem pela frente.', periodo: false,
  async render(v, p) {
    const r = await api(`fin/resumo-caixa${p.m ? `?m=${p.m}` : ''}`);
    const ids = r.contas.map(c => c.id);
    const sel = new Set((CONTAS_SEL || ids).filter(id => ids.includes(id)));
    v.innerHTML = `
      <div class="res-grid">
        <div class="card saldo-card">
          <div class="saldo-top"><h3>Saldo</h3><b id="saldo-tot"></b></div>
          <a class="mini-link" href="#/cadastros?aba=contas">Gerenciar contas →</a>
          <div class="contas-lista">${r.contas.map(c => `<label class="conta-l">
              <input type="checkbox" data-sel="${c.id}" ${sel.has(c.id) ? 'checked' : ''}>
              <span><a href="#/fin/conta/${c.id}">${esc(c.conta)}</a>${c.banco ? `<small>${esc(c.banco)}</small>` : ''}</span>
              <b class="${c.saldo_atual < 0 ? 'neg' : ''}">${money(c.saldo_atual)}</b></label>`).join('')}</div>
        </div>
        <div class="card">
          <div class="graf-head"><h3>Fluxo de caixa</h3>
            <div class="mes-nav"><button class="btn sm" data-m="${somaMes(r.centro, -1)}" aria-label="Período anterior">‹</button>
              <span>${rotMes(r.ini.slice(0, 7))} – ${rotMes(r.fim.slice(0, 7))}</span>
              <button class="btn sm" data-m="${somaMes(r.centro, 1)}" aria-label="Próximo período">›</button></div></div>
          ${legend([['Realizado', COL.saldo], ['Projetado (tracejado)', COL.saldo + '88']])}
          <div class="chart"><canvas id="c-res"></canvas></div>
          <p class="muted small-txt">A projeção soma os títulos em aberto (Nibo e app) ao saldo das contas marcadas; vencidos ficam de fora.</p>
        </div>
      </div>
      <div class="grid g-1-1">${listaTitulos(r.receber, 'receber')}${listaTitulos(r.pagar, 'pagar')}</div>`;

    const dias = diasEntre(r.ini, r.fim);
    const desenhar = () => {
      charts.forEach(c => c.destroy()); charts = [];
      const S = r.contas.filter(c => sel.has(c.id));
      v.querySelector('#saldo-tot').textContent = money(S.reduce((s, c) => s + c.saldo_atual, 0));
      const delta = {};
      r.realizado.filter(x => sel.has(x.conta_id)).forEach(x => { delta[x.data] = (delta[x.data] || 0) + x.valor; });
      const proj = Object.fromEntries(r.projetado.map(x => [x.data, (x.entradas || 0) - (x.saidas || 0)]));
      let saldo = S.reduce((s, c) => s + c.saldo_ini, 0);
      const vals = dias.map(d => { saldo += d <= r.hoje ? (delta[d] || 0) : (proj[d] || 0); return Math.round(saldo * 100) / 100; });
      graficoSaldo(v.querySelector('#c-res'), dias, vals, r.hoje);
    };
    v.querySelectorAll('[data-sel]').forEach(cb => cb.onchange = () => {
      cb.checked ? sel.add(cb.dataset.sel) : sel.delete(cb.dataset.sel);
      CONTAS_SEL = [...sel];
      try { localStorage.setItem('cockpit.contasSel', JSON.stringify(CONTAS_SEL)); } catch (_) { /* ok */ }
      desenhar();
    });
    v.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { location.hash = `#/fin/resumo?m=${b.dataset.m}`; });
    // Botões Próximos / Em aberto / Vencido: troca só a lista daquele card.
    v.querySelectorAll('[data-tit]').forEach(card => {
      const tipo = card.dataset.tit;
      card.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
        card.querySelectorAll('[data-f]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
        card.querySelector('.tit-list').innerHTML = linhasTitulos(r[tipo][b.dataset.f]);
        const st = { proximos: 'aberto', aberto: 'aberto', vencidos: 'vencido' }[b.dataset.f];
        card.querySelector('[data-mais]').href = b.dataset.f === 'vencidos'
          ? `#/fin/contas?tipo=${tipo}&status=vencido&p=custom&ini=2020-01-01&fim=${hojeIso()}`
          : `#/fin/contas?tipo=${tipo}&status=${st}&p=90`;
      });
    });
    desenhar();
  },
};

// ---------------------------------------------------------------- conta e extrato
PAGES['fin/conta'] = {
  eyebrow: 'Fluxo de caixa', title: 'Contas e extratos', lede: 'Extrato do mês, projeção e lançamentos direto na conta.', periodo: false,
  async render(v, p) {
    await finOpcoes();
    let id = p.id;
    if (!id) { id = FIN_OPCOES.contas[0]?.id; if (!id) { v.innerHTML = '<div class="card empty">Nenhuma conta cadastrada.</div>'; return; } }
    const r = await api(`fin/contas/${id}/extrato${p.mes ? `?mes=${p.mes}` : ''}`);
    const c = r.conta;
    const flash = FLASH; FLASH = '';
    let saldo = r.saldo_anterior;
    const linhas = r.movimentos.map((m, i) => {
      saldo += m.valor;
      const mesmoDia = i > 0 && r.movimentos[i - 1].data === m.data;
      const acao = m.lancamento_id ? `<a class="ico-btn" href="#/fin/lancamento/${m.lancamento_id}" title="Editar lançamento" aria-label="Editar lançamento">✎</a>`
        : m.transferencia_id ? `<button class="ico-btn" data-desfaz="${m.transferencia_id}" title="Desfazer transferência" aria-label="Desfazer transferência">↺</button>` : '';
      return `<tr class="${m.transferencia ? 'transf' : ''}">
        <td>${mesmoDia ? '' : dm(m.data) + '/' + m.data.slice(2, 4)}</td>
        <td title="${esc(m.nome || '')}">${m.origem !== 'nibo' ? '<span class="badge manual">app</span> ' : ''}${esc(m.nome || '')}</td>
        <td class="ext-desc" title="${esc(m.descricao || '')}">${esc(m.descricao || '')}</td><td class="muted" title="${esc(m.categoria || '')}">${esc(m.categoria || '')}</td>
        <td class="n">${m.valor > 0 ? fmtMoeda(m.valor) : ''}</td><td class="n neg">${m.valor < 0 ? `(${fmtMoeda(-m.valor)})` : ''}</td>
        <td class="n ${saldo < 0 ? 'neg' : ''}">${r.movimentos[i + 1]?.data === m.data ? '' : fmtMoeda(saldo)}</td>
        <td class="acoes">${acao}</td></tr>`;
    }).join('');
    const saldoFim = saldo;
    const total = r.contas.reduce((s, x) => s + x.saldo_atual, 0);
    v.innerHTML = `
      ${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      <div class="ct-grid">
        <div class="card ct-lista">
          ${r.contas.map(x => `<a class="ct-item ${x.id === id ? 'on' : ''}" href="#/fin/conta/${x.id}${p.mes ? `?mes=${p.mes}` : ''}">
            <span>${esc(x.conta)}${x.banco ? `<small>${esc(x.banco)}</small>` : ''}</span><b class="${x.saldo_atual < 0 ? 'neg' : ''}">${fmtMoeda(x.saldo_atual)}</b></a>`).join('')}
          <div class="ct-tot"><span>Saldo (R$)</span><b>${fmtMoeda(total)}</b></div>
        </div>
        <div class="ct-main">
          <div class="card">
            <div class="graf-head"><div><h2 class="ct-nome">${esc(c.conta)}</h2>
              <div class="muted small-txt">${[c.banco, c.finalidade].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div></div>
              <div class="mes-nav"><button class="btn sm" data-mes="${somaMes(r.mes, -1)}" aria-label="Mês anterior">‹</button>
                <span>${rotMes(r.mes)}</span><button class="btn sm" data-mes="${somaMes(r.mes, 1)}" aria-label="Próximo mês">›</button></div></div>
            <div class="chart short"><canvas id="c-ct"></canvas></div>
          </div>
          <div class="ct-acoes">
            <button class="btn" data-novo="pagar">↓ Novo pagamento</button>
            <button class="btn" data-novo="receber">↑ Novo recebimento</button>
            <button class="btn" data-novo="transf">⇄ Nova transferência</button>
          </div>
          <div class="card"><h3>Extrato</h3>
            <div class="table-wrap tall"><table class="extrato"><thead><tr><th>Data</th><th>Nome</th><th>Descrição</th><th>Categoria</th>
              <th class="n">Entrada</th><th class="n">Saída</th><th class="n">Saldo</th><th aria-label="Ações"></th></tr></thead><tbody>
              <tr class="ext-ant"><td>${dm(iso(new Date(parseD(r.ini).getTime() - 864e5)))}</td><td></td><td>Saldo anterior</td><td></td><td></td><td></td>
                <td class="n ${r.saldo_anterior < 0 ? 'neg' : ''}">${fmtMoeda(r.saldo_anterior)}</td><td></td></tr>
              ${linhas || '<tr><td colspan="8" class="muted">Nenhum movimento neste mês.</td></tr>'}
              <tr class="ext-ant"><td></td><td></td><td>Saldo final do mês</td><td></td><td></td><td></td>
                <td class="n ${saldoFim < 0 ? 'neg' : ''}"><b>${fmtMoeda(saldoFim)}</b></td><td></td></tr>
            </tbody></table></div>
          </div>
        </div>
      </div>`;

    // gráfico do mês: saldo diário realizado + previstos do app nesta conta depois de hoje
    const dias = diasEntre(r.ini, r.fim);
    const delta = {};
    r.movimentos.forEach(m => { delta[m.data] = (delta[m.data] || 0) + m.valor; });
    const prev = Object.fromEntries(r.previstos.map(x => [x.data, (x.entradas || 0) - (x.saidas || 0)]));
    let s = r.saldo_anterior;
    const vals = dias.map(d => { s += d <= r.hoje ? (delta[d] || 0) : (prev[d] || 0); return Math.round(s * 100) / 100; });
    graficoSaldo(v.querySelector('#c-ct'), dias, vals, r.hoje);

    v.querySelectorAll('[data-mes]').forEach(b => b.onclick = () => { location.hash = `#/fin/conta/${id}?mes=${b.dataset.mes}`; });
    v.querySelectorAll('[data-novo]').forEach(b => b.onclick = () => painelMovimento(b.dataset.novo, id));
    v.querySelectorAll('[data-desfaz]').forEach(b => b.onclick = async () => {
      if (!confirm('Desfazer esta transferência? As duas pontas (saída e entrada) somem do extrato.')) return;
      await send('POST', `fin/transferencias/${b.dataset.desfaz}/cancelar`);
      FLASH = 'Transferência desfeita.'; render();
    });
  },
};

// ---------------------------------------------------------------- painel lateral (pagamento / recebimento / transferência)
function painelMovimento(tipo, contaId) {
  let dr = document.getElementById('drawer');
  if (!dr) { dr = document.createElement('dialog'); dr.id = 'drawer'; dr.className = 'drawer'; document.body.appendChild(dr); }
  const hoje = hojeIso();
  const contaOpts = sel => FIN_OPCOES.contas.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.conta)}</option>`).join('');
  const transf = tipo === 'transf';
  const titulo = transf ? 'Nova transferência' : tipo === 'pagar' ? 'Novo pagamento' : 'Novo recebimento';
  const totRot = tipo === 'pagar' ? 'Total pago' : 'Total recebido';
  dr.innerHTML = `<form class="drawer-body" autocomplete="off">
    <div class="drawer-head"><h3>${titulo}</h3><button type="button" class="btn sm" data-fechar aria-label="Fechar">✕</button></div>
    <div class="drawer-campos">
      ${transf ? `
        <label>Data *<input type="date" name="data" value="${hoje}" required></label>
        <label>Conta de origem *<select name="conta_origem_id">${contaOpts(contaId)}</select></label>
        <label>Conta destino *<select name="conta_destino_id" required><option value="">Selecione uma conta</option>${contaOpts(null)}</select></label>
        <label class="span2">Descrição<input name="descricao" maxlength="200" placeholder="Ex.: Transferência do Pagseguro para o Sicoob"></label>
        <label>Valor *<input class="money" inputmode="decimal" name="valor" placeholder="0,00" required></label>`
      : `
        <label>${tipo === 'pagar' ? 'Pagamento' : 'Recebimento'} *<input type="date" name="data" value="${hoje}" required></label>
        <label>Competência<input type="date" name="competencia" value="${hoje}"></label>
        <label>Conta *<select name="conta_id">${contaOpts(contaId)}</select></label>
        <div class="campo span2"><span class="campo-rot">${tipo === 'pagar' ? 'Fornecedor' : 'Cliente / pagador'}</span>${pickerPessoa(null, '')}</div>
        <label class="span2">Descrição<input name="descricao" maxlength="500" placeholder="Ex.: Serviço prestado"></label>
        <label class="span2">Categoria<select name="categoria_id">${categoriaOptions(tipo, null)}</select></label>
        <label>Valor *<input class="money" inputmode="decimal" name="valor" placeholder="0,00" required></label>`}
    </div>
    <div class="dlg-err" hidden></div>
    <div class="drawer-foot">
      ${transf ? '<span></span>' : `<div><small>${totRot}</small><b data-tot>0,00</b></div>`}
      <div class="actions"><button type="button" class="btn" data-fechar>Cancelar</button>
        <button class="btn primary">${transf ? 'Transferir' : tipo === 'pagar' ? 'Pagar' : 'Receber'}</button></div>
    </div>
  </form>`;
  const f = dr.querySelector('form');
  if (!transf) ligarPicker(f.querySelector('[data-picker]'));
  f.addEventListener('input', () => { const t = f.querySelector('[data-tot]'); if (t) t.textContent = fmtMoeda(lerMoeda(f.valor.value) || 0); });
  dr.querySelectorAll('[data-fechar]').forEach(b => b.onclick = () => dr.close());
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const err = dr.querySelector('.dlg-err'); err.hidden = true;
    const valor = lerMoeda(f.valor.value);
    try {
      if (!(valor > 0)) throw new Error('Informe um valor maior que zero');
      if (transf) {
        if (!f.conta_destino_id.value) throw new Error('Escolha a conta de destino');
        await send('POST', 'fin/transferencias', { data: f.data.value, conta_origem_id: f.conta_origem_id.value,
          conta_destino_id: f.conta_destino_id.value, valor, descricao: f.descricao.value.trim() || null });
        FLASH = `Transferência de ${money(valor)} registrada.`;
      } else {
        await send('POST', 'fin/lancamentos', {
          tipo, vencimento: f.data.value, competencia: f.competencia.value || null, data_pagamento: f.data.value,
          status: 'pago', valor, valor_pago: valor, conta_id: f.conta_id.value, contato_id: f.contato_id.value || null,
          categoria_id: f.categoria_id.value || null, descricao: f.descricao.value.trim() || null, repeticao: 'nenhuma', vezes: 1,
        });
        FLASH = `${tipo === 'pagar' ? 'Pagamento' : 'Recebimento'} de ${money(valor)} registrado.`;
      }
      dr.close();
      FIN_OPCOES = null;
      render();
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
  });
  dr.showModal();
  f.querySelector('input[name=data]').focus();
}
