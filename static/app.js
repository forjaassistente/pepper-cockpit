// Cockpit do restaurante — SPA simples, rotas por hash.
const css = getComputedStyle(document.documentElement);
const C = name => css.getPropertyValue(`--${name}`).trim();
const COL = { salao: C('salao'), delivery: C('delivery'), entrada: C('entrada'), saida: C('saida'), saldo: C('saldo') };

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const money = v => brl.format(v || 0);
const pct = v => `${num1.format(v || 0)}%`;

// Campos de dinheiro (input.money): formato brasileiro 1.234,56, estilo maquininha:
// os dígitos entram pela direita e os centavos ficam sempre preenchidos (15370 → 153,70).
const fmtMoeda = v => (v === '' || v == null || isNaN(Number(v))) ? ''
  : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function lerMoeda(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '').replace(/[R$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (!/^-?\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}
document.addEventListener('input', e => {
  const i = e.target;
  if (!i.matches?.('input.money')) return;
  const digitos = i.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
  const novo = digitos ? fmtMoeda(Number(digitos) / 100) : '';
  if (novo !== i.value) {
    i.value = novo;
    i.setSelectionRange?.(novo.length, novo.length);   // cursor sempre no fim, como na maquininha
  }
}, true);
// Telefone (input.phone): começa só com "()" para digitar o DDD e formata enquanto digita: (49) 99966-7096.
function fmtTelefone(v) {
  const d = String(v ?? '').replace(/\D/g, '').slice(0, 11);
  if (!d) return '';
  if (d.length < 2) return `(${d})`;
  if (d.length === 2) return `(${d}) `;
  const ddd = d.slice(0, 2), n = d.slice(2);
  if (n.length <= 4) return `(${ddd}) ${n}`;
  const corte = n.length === 9 ? 5 : 4;   // celular 9 dígitos, fixo 8
  return `(${ddd}) ${n.slice(0, corte)}-${n.slice(corte)}`;
}
document.addEventListener('focusin', e => {
  const i = e.target;
  if (!i.matches?.('input.phone') || i.value.trim()) return;
  i.value = '()';
  requestAnimationFrame(() => { if (i.value === '()') i.setSelectionRange?.(1, 1); });   // cursor dentro dos parênteses
});
document.addEventListener('input', e => {
  const i = e.target;
  if (!i.matches?.('input.phone')) return;
  const apagando = e.inputType?.startsWith('delete');
  const novo = fmtTelefone(i.value);
  if (apagando && novo.length >= i.value.length) return;   // deixa apagar o "-" e o ")" livremente
  if (novo !== i.value) {
    i.value = novo;
    const pos = novo.replace(/\D/g, '').length < 2 ? novo.length - 1 : novo.length;   // enquanto digita o DDD, fica antes do ")"
    i.setSelectionRange?.(pos, pos);
  }
}, true);
document.addEventListener('focusout', e => {
  const i = e.target;
  if (i.matches?.('input.phone') && i.value.replace(/\D/g, '').length <= 2) i.value = '';   // vazio ou só o DDD: fica vazio
});

document.addEventListener('focusout', e => {
  const i = e.target;
  if (!i.matches?.('input.money') || !i.value.trim()) return;
  const n = lerMoeda(i.value);
  const f = isNaN(n) ? '' : fmtMoeda(n);
  if (f === i.value) return;
  i.value = f;
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new Event('change', { bubbles: true }));
});
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const parseD = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dm = s => { const d = parseD(s); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };
const dmw = s => `${dm(s)} ${DOW[parseD(s).getDay()]}`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function delta(atual, base) {
  if (!base) return '<span class="delta">—</span>';
  const d = (atual / base - 1) * 100;
  const cls = d >= 0 ? 'up' : 'down';
  return `<span class="delta ${cls}">${d >= 0 ? '▲' : '▼'} ${num1.format(Math.abs(d))}%</span>`;
}

// ---------- período ----------
const PRESETS = [
  ['7', '7 dias'], ['30', '30 dias'], ['mes', 'Este mês'], ['mes_ant', 'Mês passado'], ['90', '90 dias'], ['ano', 'No ano'],
];
let periodo = { preset: '30' };
try { periodo = JSON.parse(localStorage.getItem('cockpit.periodo')) || periodo; } catch (_) { /* sem storage */ }

function datas() {
  const hoje = new Date();
  const p = periodo.preset;
  if (p === 'custom' && periodo.ini && periodo.fim) return { ini: periodo.ini, fim: periodo.fim };
  if (p === 'mes') return { ini: iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), fim: iso(hoje) };
  if (p === 'mes_ant') return {
    ini: iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)),
    fim: iso(new Date(hoje.getFullYear(), hoje.getMonth(), 0)),
  };
  if (p === 'ano') return { ini: iso(new Date(hoje.getFullYear(), 0, 1)), fim: iso(hoje) };
  const n = Number(p) || 30;
  const ini = new Date(hoje); ini.setDate(ini.getDate() - n + 1);
  return { ini: iso(ini), fim: iso(hoje) };
}

function setPeriodo(p) {
  periodo = p;
  try { localStorage.setItem('cockpit.periodo', JSON.stringify(p)); } catch (_) { /* ok */ }
  renderPeriodo();
  render();
}

function renderPeriodo() {
  const { ini, fim } = datas();
  document.getElementById('chips').innerHTML = PRESETS.map(([k, l]) =>
    `<button class="chip ${periodo.preset === k ? 'on' : ''}" data-p="${k}">${l}</button>`).join('');
  document.getElementById('ini').value = ini;
  document.getElementById('fim').value = fim;
}
document.getElementById('chips').addEventListener('click', e => {
  const b = e.target.closest('[data-p]');
  if (b) setPeriodo({ preset: b.dataset.p });
});
['ini', 'fim'].forEach(id => document.getElementById(id).addEventListener('change', () => {
  const ini = document.getElementById('ini').value, fim = document.getElementById('fim').value;
  if (ini && fim && ini <= fim) setPeriodo({ preset: 'custom', ini, fim });
}));

// ---------- dados ----------
function erroDe(j, status) {
  const d = j.detail;
  if (Array.isArray(d)) return d.map(x => `${(x.loc || []).slice(-1)[0]}: ${x.msg}`).join(' · ');
  return d || j.erro || `Erro ${status}`;
}

async function api(path, comPeriodo) {
  const qs = comPeriodo ? `${path.includes('?') ? '&' : '?'}${new URLSearchParams(datas())}` : '';
  const r = await fetch(`/api/${path}${qs}`);
  if (r.status === 401 && !path.startsWith('auth/')) sessaoExpirada();
  if (!r.ok) throw new Error(erroDe(await r.json().catch(() => ({})), r.status));
  return r.json();
}

// Gravações: o cabeçalho x-cockpit é exigido pelo servidor em qualquer método que não seja GET.
async function send(method, path, body) {
  const r = await fetch(`/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-cockpit': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('auth/')) sessaoExpirada();
  if (!r.ok) throw new Error(erroDe(j, r.status));
  return j;
}

// ---------- gráficos ----------
Chart.defaults.font.family = 'Inter, -apple-system, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.color = C('ink-2');
Chart.defaults.plugins.legend.display = false; // legenda em HTML acima do gráfico
Chart.defaults.plugins.tooltip.backgroundColor = '#14304D';
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.plugins.tooltip.boxPadding = 4;
let charts = [];

const moneyTick = v => brl0.format(v).replace(/\s/g, ' ');
const tooltipBRL = {
  mode: 'index', intersect: false,
  callbacks: {
    label: c => ` ${c.dataset.label}: ${money(c.parsed[c.chart.options.indexAxis === 'y' ? 'x' : 'y'])}`,
    footer: items => items.length > 1 && items[0].chart.options.plugins.totalFooter
      ? `Total: ${money(items.reduce((s, i) => s + (i.parsed[i.chart.options.indexAxis === 'y' ? 'x' : 'y'] || 0), 0))}`
      : '',
  },
};

function bars(el, labels, series, { stacked = true, horizontal = false, totalFooter = stacked } = {}) {
  const valueAxis = { stacked, beginAtZero: true, grid: { color: '#EAF1F8' }, border: { display: false }, ticks: { callback: moneyTick, maxTicksLimit: 6 } };
  const catAxis = { stacked, grid: { display: false }, border: { color: C('line') }, ticks: { autoSkip: true, maxRotation: 0 } };
  charts.push(new Chart(el, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map(s => ({
        label: s.label, data: s.data, backgroundColor: s.color,
        borderColor: '#fff', borderWidth: stacked ? { top: 2, right: 2 } : 0, borderSkipped: false,
        borderRadius: 4, maxBarThickness: horizontal ? 22 : 34, categoryPercentage: .78, barPercentage: stacked ? .9 : .82,
      })),
    },
    options: {
      indexAxis: horizontal ? 'y' : 'x', responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: tooltipBRL, totalFooter },
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    },
  }));
}

function line(el, labels, label, data, color) {
  charts.push(new Chart(el, {
    type: 'line',
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '1A', fill: 'origin', borderWidth: 1.25, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: '#fff', tension: .25 }] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: tooltipBRL },
      scales: {
        x: { grid: { display: false }, border: { color: C('line') }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { grid: { color: '#EAF1F8' }, border: { display: false }, ticks: { callback: moneyTick, maxTicksLimit: 6 } },
      },
    },
  }));
}

const legend = items => `<div class="legend">${items.map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`;
const kpi = (label, value, foot = '') => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
const table = (cols, rows) => `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.n ? 'n' : ''}">${c.t}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(r => `<tr>${cols.map(c => { const v = c.f(r); return `<td class="${c.n ? 'n' : ''}${c.neg && c.raw(r) < 0 ? ' neg' : ''}">${v}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
const splitCard = (titulo, sub, salao, delivery) => {
  const tot = salao + delivery || 1;
  return `<div class="card"><h3>${titulo}</h3><div class="sub">${sub}</div>
    <div class="split-bar"><div style="width:${salao / tot * 100}%;background:${COL.salao}"></div><div style="width:${delivery / tot * 100}%;background:${COL.delivery}"></div></div>
    <div class="split-row"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COL.salao};margin-right:6px"></i>Salão</span><span>${pct(salao / tot * 100)} · <b>${money(salao)}</b></span></div>
    <div class="split-row"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COL.delivery};margin-right:6px"></i>Delivery</span><span>${pct(delivery / tot * 100)} · <b>${money(delivery)}</b></span></div>
  </div>`;
};
const periodoTxt = p => `${dm(p.ini)} a ${dm(p.fim)}`;

// ---------- páginas ----------
const PAGES = {
  painel: {
    eyebrow: 'Visão geral', title: 'Dashboard', lede: 'O dia de ontem, o mês até agora e o caixa — numa leitura só.', periodo: false,
    async render(v) {
      const r = await api('resumo');
      const u = r.ultimo, sp = r.semana_passada || {}, m = r.mes;
      const pctSal = m.salao / (m.atual || 1) * 100;
      const maxPag = Math.max(...r.pagamentos.map(p => p.valor), 1);
      v.innerHTML = `
        <div class="grid g4">
          ${kpi(`Último dia · ${dmw(u.data)}`, money(u.total), `${delta(u.total, sp.total)} vs ${sp.data ? dmw(sp.data) : 'semana passada'} · média do dia ${money(r.media_dow.media_total)}`)}
          ${kpi(`Mês até ${dm(u.data)}`, money(m.atual), `${delta(m.atual, m.anterior)} vs mesmo período do mês passado (${money(m.anterior)})`)}
          ${kpi('Canal no mês', `${num1.format(pctSal)}% salão`, `${num1.format(100 - pctSal)}% delivery · ${money(m.delivery)}`)}
          ${kpi('Caixa · últimos 30 dias', money(r.caixa.saldo), `Entradas ${money(r.caixa.entradas)} · Saídas ${money(r.caixa.saidas)}`)}
        </div>
        <div class="grid g-2-1">
          <div class="card"><h3>Últimos 14 dias</h3><div class="sub">Faturamento diário por canal</div>
            ${legend([['Salão', COL.salao], ['Delivery', COL.delivery]])}<div class="chart"><canvas id="c1"></canvas></div></div>
          <div class="grid">
            ${splitCard(`Último dia · ${dmw(u.data)}`, 'Divisão por canal', u.salao, u.delivery)}
            <div class="card"><h3>Formas de pagamento no mês</h3><div class="sub">Top 5, salão + delivery</div>
              <div class="bar-list">${r.pagamentos.map(p => `<div class="row"><span>${esc(p.forma)}</span><div class="track"><div class="fill" style="width:${p.valor / maxPag * 100}%"></div></div><span class="v">${brl0.format(p.valor)}</span></div>`).join('')}</div>
            </div>
          </div>
        </div>`;
      bars(document.getElementById('c1'), r.serie.map(d => dmw(d.data)),
        [{ label: 'Salão', data: r.serie.map(d => d.salao), color: COL.salao }, { label: 'Delivery', data: r.serie.map(d => d.delivery), color: COL.delivery }]);
    },
  },

  faturamento: {
    eyebrow: 'Relatórios e resultados', title: 'Faturamento', lede: 'Salão e delivery dia a dia no período escolhido.', periodo: true,
    async render(v) {
      const r = await api('faturamento', true), t = r.totais;
      const melhor = r.dias.reduce((a, d) => (d.total > (a?.total ?? -1) ? d : a), null);
      v.innerHTML = `
        <div class="grid g4">
          ${kpi('Faturamento no período', money(t.total), `${t.dias} dias com venda · ${periodoTxt(r.periodo)}`)}
          ${kpi('Média diária', money(t.media), melhor ? `Melhor dia: ${dmw(melhor.data)} · ${money(melhor.total)}` : '')}
          ${kpi('Salão', money(t.salao), `${pct(t.salao / (t.total || 1) * 100)} do total`)}
          ${kpi('Delivery', money(t.delivery), `${pct(t.delivery / (t.total || 1) * 100)} do total`)}
        </div>
        <div class="grid g-2-1">
          <div class="card"><h3>Faturamento diário</h3><div class="sub">Salão + delivery empilhados</div>
            ${legend([['Salão', COL.salao], ['Delivery', COL.delivery]])}<div class="chart tall"><canvas id="c1"></canvas></div></div>
          ${splitCard('Split por canal', periodoTxt(r.periodo), t.salao, t.delivery)}
        </div>
        <div class="card"><h3>Detalhe por dia</h3><div class="sub">Mais recente primeiro</div>
          ${table([
            { t: 'Data', f: d => dmw(d.data) },
            { t: 'Salão', n: 1, f: d => money(d.salao) },
            { t: 'Delivery', n: 1, f: d => money(d.delivery) },
            { t: 'Total', n: 1, f: d => `<b>${money(d.total)}</b>` },
            { t: '% Salão', n: 1, f: d => pct(d.pct_salao) },
            { t: '% Delivery', n: 1, f: d => pct(d.pct_delivery) },
          ], [...r.dias].reverse())}</div>`;
      if (!r.dias.length) return;
      bars(document.getElementById('c1'), r.dias.map(d => dmw(d.data)),
        [{ label: 'Salão', data: r.dias.map(d => d.salao), color: COL.salao }, { label: 'Delivery', data: r.dias.map(d => d.delivery), color: COL.delivery }]);
    },
  },

  'dias-semana': {
    eyebrow: 'Relatórios e resultados', title: 'Dias da semana', lede: 'Média de faturamento por dia da semana, considerando todo o histórico.', periodo: false,
    async render(v) {
      const r = await api('dias-semana');
      const top = r.reduce((a, d) => (d.media_total > a.media_total ? d : a), r[0]);
      const low = r.reduce((a, d) => (d.media_total < a.media_total ? d : a), r[0]);
      v.innerHTML = `
        <div class="grid g3">
          ${kpi('Dia mais forte', top.dia_semana, `Média de ${money(top.media_total)}`)}
          ${kpi('Dia mais fraco', low.dia_semana, `Média de ${money(low.media_total)}`)}
          ${kpi('Diferença', `${num1.format(top.media_total / low.media_total)}×`, `${top.dia_semana} vende ${num1.format(top.media_total / low.media_total)} vezes ${low.dia_semana.toLowerCase()}`)}
        </div>
        <div class="card"><h3>Média por dia da semana</h3><div class="sub">Salão + delivery empilhados</div>
          ${legend([['Salão', COL.salao], ['Delivery', COL.delivery]])}<div class="chart tall"><canvas id="c1"></canvas></div></div>
        <div class="card"><h3>Detalhe</h3><div class="sub">Dias considerados = quantos dias com venda entraram na média</div>
          ${table([
            { t: 'Dia', f: d => esc(d.dia_semana) },
            { t: 'Dias', n: 1, f: d => d.dias_considerados },
            { t: 'Média total', n: 1, f: d => `<b>${money(d.media_total)}</b>` },
            { t: 'Média salão', n: 1, f: d => money(d.media_salao) },
            { t: 'Média delivery', n: 1, f: d => money(d.media_delivery) },
            { t: '% Salão', n: 1, f: d => pct(d.pct_salao) },
            { t: '% Delivery', n: 1, f: d => pct(d.pct_delivery) },
          ], r)}</div>`;
      bars(document.getElementById('c1'), r.map(d => d.dia_semana),
        [{ label: 'Salão', data: r.map(d => d.media_salao), color: COL.salao }, { label: 'Delivery', data: r.map(d => d.media_delivery), color: COL.delivery }]);
    },
  },

  pagamentos: {
    eyebrow: 'Relatórios e resultados', title: 'Formas de pagamento', lede: 'Como o cliente pagou, separado por salão e delivery.', periodo: true,
    async render(v) {
      const r = await api('pagamentos', true);
      const tot = r.formas.reduce((s, f) => s + f.total, 0) || 1;
      const top = r.formas[0];
      v.innerHTML = `
        <div class="grid g3">
          ${kpi('Total recebido', money(tot), periodoTxt(r.periodo))}
          ${kpi('Forma principal', top ? esc(top.forma) : '—', top ? `${pct(top.total / tot * 100)} · ${money(top.total)}` : '')}
          ${kpi('Formas usadas', r.formas.length, 'No período escolhido')}
        </div>
        <div class="grid g-1-1">
          <div class="card"><h3>Por forma de pagamento</h3><div class="sub">Salão + delivery empilhados</div>
            ${legend([['Salão', COL.salao], ['Delivery', COL.delivery]])}<div class="chart tall"><canvas id="c1"></canvas></div></div>
          <div class="card"><h3>Detalhe</h3><div class="sub">Ordenado pelo total</div>
            ${table([
              { t: 'Forma', f: f => esc(f.forma) },
              { t: 'Salão', n: 1, f: f => money(f.salao) },
              { t: 'Delivery', n: 1, f: f => money(f.delivery) },
              { t: 'Total', n: 1, f: f => `<b>${money(f.total)}</b>` },
              { t: '%', n: 1, f: f => pct(f.total / tot * 100) },
            ], r.formas)}</div>
        </div>`;
      bars(document.getElementById('c1'), r.formas.map(f => f.forma),
        [{ label: 'Salão', data: r.formas.map(f => f.salao), color: COL.salao }, { label: 'Delivery', data: r.formas.map(f => f.delivery), color: COL.delivery }],
        { horizontal: true });
    },
  },

  fluxo: {
    eyebrow: 'Fluxo de caixa', title: 'Fluxo realizado', lede: 'Entradas e saídas já registradas no Nibo.', periodo: true,
    async render(v) {
      const r = await api('fluxo', true), t = r.totais;
      v.innerHTML = `
        <div class="grid g3">
          ${kpi('Entradas', money(t.entradas), periodoTxt(r.periodo))}
          ${kpi('Saídas', money(t.saidas), periodoTxt(r.periodo))}
          ${kpi('Saldo do período', `<span class="${t.saldo < 0 ? 'neg' : ''}">${money(t.saldo)}</span>`, 'Entradas − saídas')}
        </div>
        <div class="card"><h3>Entradas x saídas por dia</h3><div class="sub">Valores diários do Nibo</div>
          ${legend([['Entradas', COL.entrada], ['Saídas', COL.saida]])}<div class="chart"><canvas id="c1"></canvas></div></div>
        <div class="grid g-1-1">
          <div class="card"><h3>Saldo acumulado no período</h3><div class="sub">Soma dos saldos diários a partir de ${dm(r.periodo.ini)}</div>
            <div class="chart short"><canvas id="c2"></canvas></div></div>
          <div class="card"><h3>Detalhe por dia</h3><div class="sub">Mais recente primeiro</div>
            ${table([
              { t: 'Data', f: d => dmw(d.data) },
              { t: 'Entradas', n: 1, f: d => money(d.entradas) },
              { t: 'Saídas', n: 1, f: d => money(d.saidas) },
              { t: 'Saldo', n: 1, neg: 1, raw: d => d.saldo_do_dia, f: d => money(d.saldo_do_dia) },
            ], [...r.dias].reverse())}</div>
        </div>`;
      if (!r.dias.length) return;
      const labels = r.dias.map(d => dmw(d.data));
      bars(document.getElementById('c1'), labels,
        [{ label: 'Entradas', data: r.dias.map(d => d.entradas), color: COL.entrada }, { label: 'Saídas', data: r.dias.map(d => d.saidas), color: COL.saida }],
        { stacked: false, totalFooter: false });
      line(document.getElementById('c2'), labels, 'Saldo acumulado', r.dias.map(d => d.acumulado), COL.saldo);
    },
  },
};

// ---------- roteador ----------
// Itens do menu que agrupam várias telas em abas. Para acrescentar uma tela a um grupo, basta incluí-la aqui.
const GRUPOS_NAV = {
  vendas: { nome: 'Relatórios e resultados', abas: [['faturamento', 'Faturamento'], ['dias-semana', 'Dias da semana'], ['pagamentos', 'Formas de pagamento']] },
  'fluxo-caixa': { nome: 'Fluxo de caixa', abas: [['fin/resumo', 'Resumo'], ['fin/contas', 'Contas a pagar e receber'], ['fin/conta', 'Contas e extratos'], ['fin/projecao', 'Projetado'], ['fluxo', 'Realizado']] },
};
// Sub-abas que aparecem no menu lateral, abaixo do item aberto.
// Grupos de telas usam a rota; telas com abas internas (RH, Cadastros) usam ?aba=.
const SUBMENU = {
  vendas: GRUPOS_NAV.vendas.abas.map(([r, rot]) => [`#/${r}`, rot, x => x.route === r]),
  'fluxo-caixa': [
    ['#/fin/resumo', 'Resumo', x => x.route === 'fin/resumo'],
    // Contas a pagar / a receber: a mesma tela com ?tipo=; lançamento novo/editado fica dentro de "a pagar" por padrão
    ['#/fin/contas?tipo=pagar', 'Contas a pagar', x => (x.route === 'fin/contas' && x.params.tipo !== 'receber')
      || (['fin/novo', 'fin/lancamento'].includes(x.route) && x.params.tipo !== 'receber')],
    ['#/fin/contas?tipo=receber', 'Contas a receber', x => ['fin/contas', 'fin/novo'].includes(x.route) && x.params.tipo === 'receber'],
    ['#/fin/conta', 'Contas e extratos', x => x.route === 'fin/conta'],
    ['#/fin/projecao', 'Projetado', x => x.route === 'fin/projecao'],
    ['#/fluxo', 'Realizado', x => x.route === 'fluxo'],
  ],
  // Cardápio: a equipe só vê as fichas de produção (sem custos); o admin vê tudo
  get cardapio() {
    const abas = USUARIO?.perfil === 'admin' ? [['engenharia', 'Engenharia de cardápio'], ['precificacao', 'Precificação'], ['vendas', 'Vendas por produto']] : [];
    return [...abas.map(([a, rot], i) => [`#/cardapio?aba=${a}`, rot, x => x.route === 'cardapio' && (x.params.aba || (i === 0 ? a : '')) === a]),
      ['#/producao', 'Fichas de produção', x => x.route === 'producao']];
  },
  // Lista de tarefas: o admin também monta os checklists de rotina
  get afazeres() {
    return USUARIO?.perfil === 'admin' ? [['#/afazeres', 'Tarefas', x => x.route === 'afazeres' && x.params.aba !== 'checklists'],
      ['#/afazeres?aba=checklists', 'Checklists', x => (x.route === 'afazeres' && x.params.aba === 'checklists') || x.route === 'checklist']] : [];
  },
  // Estoque: o admin vê tudo; quem só tem habilitação de estoque vê a contagem
  get estoque() {
    const abas = USUARIO?.perfil === 'admin' ? [['contagem', 'Contagem'], ['atual', 'Estoque atual'], ['historico', 'Histórico'], ['config', 'Configurar contagem']] : [];
    return abas.map(([a, rot], i) => [`#/estoque?aba=${a}`, rot, x => (x.params.aba || (i === 0 ? a : '')) === a]);
  },
  rh: [['funcionarios', 'Funcionários'], ['freelances', 'Free lances'], ['ponto', 'Ponto'], ['vales', 'Vales e consumos'], ['holerites', 'Holerites'], ['candidatos', 'Candidatos']]
    .map(([a, rot], i) => [`#/rh?aba=${a}`, rot, x => (x.params.aba || (i === 0 ? a : '')) === a]),
  // Cadastros: as áreas de AREAS_CAD (cadastros.js) viram títulos pequenos no submenu.
  get cadastros() {
    return AREAS_CAD.flatMap(area => [[null, area.nome],
      ...area.abas.map(([a, rot]) => [`#/cadastros?aba=${a}`, rot, x => (x.params.aba || 'contas') === a])]);
  },
};

function submenuLateral(nav, route, params) {
  document.querySelectorAll('nav .nav-sub').forEach(el => el.remove());
  const itens = SUBMENU[nav];
  const pai = document.querySelector(`nav a[data-route="${nav}"]`);
  if (!itens?.length || !pai || pai.hidden) return;
  pai.insertAdjacentHTML('afterend', `<div class="nav-sub">${itens.map(([href, rot, ativo]) => href === null
    ? `<span class="nav-sub-t">${rot}</span>`
    : `<a href="${href}" class="${ativo({ route, params }) ? 'on' : ''}">${rot}</a>`).join('')}</div>`);
}

const NAV_DE = { 'fin/novo': 'fluxo-caixa', 'fin/lancamento': 'fluxo-caixa', conciliar: 'inbox', checklist: 'afazeres', producao: 'cardapio' };

function rota() {
  const [path, query] = (location.hash.replace(/^#\//, '') || rotaInicial()).split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  const comId = ['fin/lancamento', 'fin/conta'].find(r => path.startsWith(r + '/'));
  const route = comId || path;
  if (comId) params.id = path.split('/')[2];
  const grupo = Object.keys(GRUPOS_NAV).find(g => GRUPOS_NAV[g].abas.some(([r]) => r === route));
  return { route, nav: grupo || NAV_DE[route] || route, grupo, params };
}

// tela de onde a pessoa veio (para "voltar" depois de concluir algo, ex.: salvar a conciliação de uma nota)
let HASH_ATUAL = null, HASH_ANTERIOR = null;
const voltarOuIr = padrao => { location.hash = HASH_ANTERIOR || padrao; };

async function render() {
  if (!USUARIO) return;
  if (location.hash !== HASH_ATUAL) {
    // a própria conciliação troca ?doc= por ?id= — não conta como "tela anterior"
    if (HASH_ATUAL && !HASH_ATUAL.startsWith('#/conciliar')) HASH_ANTERIOR = HASH_ATUAL;
    HASH_ATUAL = location.hash;
    document.querySelectorAll('dialog.drawer[open]').forEach(d => { d.onclose = null; d.close(); });   // trocou de tela: fecha painéis
  }
  const { route, nav, grupo, params } = rota();
  if (route === 'cardapio' && !ehAdmin() && USUARIO) { location.hash = '#/producao'; return; }   // equipe: Cardápio = fichas de produção
  if (!rotaPermitida(route)) { location.hash = `#/${rotaInicial()}`; return; }
  const page = PAGES[route] || PAGES.painel;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.route === nav));
  document.getElementById('eyebrow').textContent = grupo ? GRUPOS_NAV[grupo].nome : page.eyebrow;
  document.getElementById('subtabs').hidden = true;
  submenuLateral(nav, route, params);
  document.getElementById('title').textContent = page.title;
  document.getElementById('lede').textContent = page.lede;
  document.getElementById('period').hidden = !page.periodo;
  document.title = `${page.title} · Cockpit ${nomeEmpresa()}`;
  charts.forEach(c => c.destroy()); charts = [];
  const v = document.getElementById('view');
  v.oninput = v.onclick = null; // páginas que tratam eventos no contêiner (caixa.js) religam a cada render
  v.innerHTML = '<div class="loading">Carregando…</div>';
  try {
    await page.render(v, params);
  } catch (e) {
    v.innerHTML = `<div class="alert"><b>Não foi possível carregar os dados.</b><br>${esc(e.message)}</div>`;
  }
}

async function renderEtl() {
  try {
    const r = await api('resumo');
    const nomes = { nibo: 'Nibo', planilhas: 'Planilhas' };
    document.getElementById('etl').innerHTML = '<div style="font-weight:600;margin-bottom:2px">Atualização dos dados</div>' +
      r.etl.map(e => {
        const d = e.fim ? new Date(e.fim) : null;
        const quando = d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—';
        const ok = e.status === 'ok';
        return `<div><span class="dot" style="background:${ok ? C('good') : C('bad')}"></span>${nomes[e.fonte] || esc(e.fonte)} · ${quando}${ok ? '' : ' · erro'}</div>`;
      }).join('');
  } catch (_) { /* rodapé é opcional */ }
}

window.addEventListener('hashchange', render);
// Espera os outros scripts (fin.js) registrarem suas páginas antes do primeiro render.
// Começa pela sessão (sessao.js): login, configuração inicial ou primeiro acesso, e só então a tela.
window.addEventListener('DOMContentLoaded', () => iniciarSessao());
