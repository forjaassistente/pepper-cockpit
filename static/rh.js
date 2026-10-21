// RH (admin): funcionários e acesso ao portal, ponto, vales/consumos e holerites.

const ABAS_RH = [['funcionarios', 'Funcionários'], ['freelances', 'Free lances'], ['ponto', 'Ponto'], ['vales', 'Vales e consumos'], ['holerites', 'Holerites'], ['candidatos', 'Candidatos']];
const VINCULO = { clt: 'CLT', free_lance: 'Free lance', estagio: 'Estágio', socio: 'Sócio', outro: 'Outro' };
const TIPO_LANC_RH = { vale: 'Vale', consumo: 'Consumo', adiantamento: 'Adiantamento', desconto: 'Desconto', bonus: 'Bônus' };
const TIPO_DOC_RH = { holerite: 'Holerite', ferias: 'Férias', decimo_terceiro: '13º salário', contrato: 'Contrato', outro: 'Outro' };
const horasMin = m => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
const mesAtual = () => iso(new Date()).slice(0, 7);
const irRH = mudar => { location.hash = `#/rh?${new URLSearchParams({ ...rota().params, ...mudar })}`; };
const navMes = (m, rot = rotMes) => `<div class="mes-nav"><button class="btn sm" data-mesrh="${somaMes(m, -1)}" aria-label="Mês anterior">‹</button>
  <span>${rot(m)}</span><button class="btn sm" data-mesrh="${somaMes(m, 1)}" aria-label="Próximo mês">›</button></div>`;

function camposFuncionario(candidatos, novo) {
  return [
    ...(novo ? [{ k: 'pessoa_id', rot: 'Já cadastrado na equipe?', tipo: 'select', span: true,
      opcoes: [['', '— Não, é uma pessoa nova —'], ...candidatos.map(c => [c.id, c.nome])] }] : []),
    { k: 'nome', rot: novo ? 'Nome (se for pessoa nova)' : 'Nome', span: true },
    { k: 'cpf', rot: 'CPF', tipo: 'cpf' },
    { k: 'telefone', rot: 'Telefone (WhatsApp)', tipo: 'tel' },
    { k: 'cargo', rot: 'Cargo / função', ph: 'Ex.: Cozinheira, Atendente' },
    { k: 'vinculo', rot: 'Vínculo', tipo: 'select', opcoes: Object.entries(VINCULO) },
    { k: 'admissao', rot: 'Admissão', tipo: 'date' },
    { k: 'desligamento', rot: 'Desligamento', tipo: 'date' },
    { k: 'salario', rot: 'Salário (R$)', tipo: 'money', nulo: true },
    { k: 'jornada_semanal', rot: 'Jornada semanal (horas)', tipo: 'number', step: '0.5', padrao: 44 },
    { k: 'observacao', rot: 'Observações', tipo: 'textarea' },
  ];
}

function dialogoAcesso(f) {
  const dlg = document.getElementById('dlg');
  dlg.className = 'dlg';
  dlg.innerHTML = `<form method="dialog" class="dlg-body">
    <h3>Acesso de ${esc(f.nome)}</h3>
    <p class="sub">${f.cpf ? `Login pelo CPF ${fmtCpf(f.cpf)}.` : '<span class="neg">Cadastre o CPF na ficha antes de liberar o acesso.</span>'}</p>
    <label>Perfil<select name="perfil">
      <option value="funcionario" ${f.perfil === 'funcionario' ? 'selected' : ''}>Funcionário — vê só o próprio portal</option>
      <option value="responsavel_caixa" ${f.perfil === 'responsavel_caixa' ? 'selected' : ''}>Responsável de caixa — portal + fechamento de caixa</option>
      <option value="nenhum" ${!f.perfil || !f.acesso_ativo ? 'selected' : ''}>Sem acesso</option></select></label>
    <div id="acesso-res"></div>
    <fieldset class="checks acesso-estoque"><legend>Contagem de estoque <small>(independe do perfil acima)</small></legend>
      ${['salao', 'cozinha'].map(s => `<label><input type="checkbox" name="estoque" value="${s}" ${(f.estoque_setores || []).includes(s) ? 'checked' : ''}
        ${f.perfil && f.acesso_ativo ? '' : 'disabled'}> ${SETOR_ROT[s]}</label>`).join('')}
      ${f.perfil && f.acesso_ativo ? '<button type="button" class="btn sm" data-estoque>Salvar habilitação</button><span class="muted small-txt" id="estoque-ok"></span>'
        : '<small class="muted">Libere o acesso ao portal primeiro.</small>'}</fieldset>
    <div class="dlg-err" hidden></div>
    <div class="actions"><button value="cancel" class="btn">Fechar</button><button value="ok" class="btn primary" ${f.cpf ? '' : 'disabled'}>Salvar e gerar link</button></div>
  </form>`;
  const form = dlg.querySelector('form');
  const btEst = dlg.querySelector('[data-estoque]');
  if (btEst) btEst.onclick = async () => {
    const err = dlg.querySelector('.dlg-err'); err.hidden = true;
    try {
      await send('PUT', `rh/funcionarios/${f.pessoa_id}/estoque`, { setores: [...form.querySelectorAll('[name=estoque]:checked')].map(i => i.value) });
      dlg.querySelector('#estoque-ok').textContent = 'Salvo ✓';
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
  };
  form.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'ok') { render(); return; }
    e.preventDefault();
    const err = dlg.querySelector('.dlg-err'); err.hidden = true;
    try {
      const r = await send('POST', `rh/funcionarios/${f.pessoa_id}/acesso`, { perfil: form.perfil.value });
      const box = dlg.querySelector('#acesso-res');
      if (!r.link) { box.innerHTML = '<div class="alert ok small">Acesso removido. As sessões abertas foram encerradas.</div>'; return; }
      const link = `${location.origin}${r.link}`;
      const tel = (f.telefone || '').replace(/\D/g, '');
      const msg = encodeURIComponent(`Olá, ${f.nome.split(' ')[0]}! Este é o seu link para criar a senha do portal ${nomeEmpresa()} (vale por ${r.validade_horas} horas): ${link}`);
      box.innerHTML = `<div class="alert ok small"><b>Link de primeiro acesso</b> (vale ${r.validade_horas} h, uso único):
        <input class="link-conv" value="${esc(link)}" readonly>
        <div class="actions" style="justify-content:flex-start;margin-top:6px">
          <button type="button" class="btn sm" data-copiar>Copiar link</button>
          ${tel ? `<a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/55${tel}?text=${msg}">Enviar pelo WhatsApp</a>` : ''}
        </div>
        <small class="muted">Enquanto o app só abre pelo túnel, o link funciona apenas no seu Mac. Ele passa a valer no celular do funcionário na etapa 2 (endereço na internet).</small></div>`;
      box.querySelector('[data-copiar]').onclick = async () => { await navigator.clipboard.writeText(link); box.querySelector('[data-copiar]').textContent = 'Copiado ✓'; };
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
  });
  dlg.showModal();
}

const ABA_RH = {
  async funcionarios(box, p) {
    const [lista, cand] = await Promise.all([api(`rh/funcionarios?inativos=${p.arq === '1'}`), api('rh/candidatos')]);
    box.innerHTML = `
      <div class="cad-head"><p class="sub">Ficha de cada funcionário e acesso ao portal (ponto, holerites, vales).</p>
        <div class="leitor-acoes"><label class="check"><input type="checkbox" id="rh-arq" ${p.arq === '1' ? 'checked' : ''}> Mostrar desligados</label>
        <button class="btn primary" data-novo>＋ Adicionar funcionário</button></div></div>
      <div class="card"><div class="table-wrap tall"><table><thead><tr><th>Nome</th><th>Cargo</th><th>Vínculo</th><th>Admissão</th>
        <th>Acesso ao portal</th><th>Último ponto</th><th></th></tr></thead><tbody>
        ${lista.map((f, i) => {
          const acesso = !f.perfil || !f.acesso_ativo ? '<span class="badge nibo">Sem acesso</span>'
            : `<span class="badge manual">${ROT_PERFIL[f.perfil]}</span>${(f.estoque_setores || []).length
                ? ` <span class="badge manual">Estoque: ${f.estoque_setores.map(s => SETOR_ROT[s].toLowerCase()).join(' e ')}</span>` : ''} ${f.tem_senha ? (f.ultimo_login ? `<small class="muted">entrou ${quando(f.ultimo_login)}</small>` : '') : '<small class="neg">aguardando 1º acesso</small>'}`;
          return `<tr class="${f.desligamento && f.desligamento <= hojeIso() ? 'arq' : ''}"><td><b>${esc(f.nome)}</b>${f.cpf ? `<small class="muted"> · ${fmtCpf(f.cpf)}</small>` : ''}</td>
            <td>${esc(f.cargo || '—')}</td><td>${VINCULO[f.vinculo]}</td><td>${f.admissao ? dm(f.admissao) + '/' + f.admissao.slice(2, 4) : '—'}</td>
            <td>${acesso}</td><td>${f.ultima_batida ? quando(f.ultima_batida) : '—'}</td>
            <td class="acoes"><button class="btn sm" data-acesso="${i}">Acesso</button> <button class="btn sm" data-edit="${i}">Editar</button></td></tr>`;
        }).join('') || '<tr><td colspan="7" class="muted">Nenhum funcionário com ficha ainda. Clique em “Adicionar funcionário”.</td></tr>'}
      </tbody></table></div></div>`;
    box.querySelector('#rh-arq').onchange = e => irRH({ arq: e.target.checked ? '1' : '' });
    box.querySelector('[data-novo]').onclick = () => dialogoCad({ titulo: 'Adicionar funcionário', campos: camposFuncionario(cand, true),
      valores: { vinculo: 'clt', jornada_semanal: 44 }, salvar: d => send('POST', 'rh/funcionarios', d) });
    box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const f = lista[b.dataset.edit];
      dialogoCad({ titulo: `Editar ${f.nome}`, campos: camposFuncionario([], false), valores: f,
        nota: 'Com data de desligamento até hoje, o acesso ao portal é desligado automaticamente.',
        salvar: d => send('PUT', `rh/funcionarios/${f.pessoa_id}`, d) });
    });
    box.querySelectorAll('[data-acesso]').forEach(b => b.onclick = () => dialogoAcesso(lista[b.dataset.acesso]));
  },

  async ponto(box, p) {
    const mes = p.mes || mesAtual();
    if (!p.pessoa) {
      const r = await api(`rh/ponto/resumo?mes=${mes}`);
      box.innerHTML = `<div class="card"><div class="graf-head"><h3>Ponto do mês</h3>${navMes(mes)}</div>
        <div class="sub">Controle interno (não substitui o ponto oficial da Portaria 671). Clique para ver o espelho.</div>
        ${table([
          { t: 'Funcionário', f: x => `<button class="link-nome" data-pessoa="${x.pessoa_id}">${esc(x.nome)}</button>` },
          { t: 'Dias com ponto', n: 1, f: x => x.dias }, { t: 'Batidas', n: 1, f: x => x.batidas },
        ], r)}</div>`;
      box.querySelectorAll('[data-pessoa]').forEach(b => b.onclick = () => irRH({ pessoa: b.dataset.pessoa }));
    } else {
      const [e, funcs] = await Promise.all([api(`rh/ponto?pessoa_id=${p.pessoa}&mes=${mes}`), api('rh/funcionarios?inativos=true')]);
      const f = funcs.find(x => x.pessoa_id === p.pessoa) || { nome: '—' };
      box.innerHTML = `<div class="card">
        <div class="graf-head"><div><button class="link-mini" data-voltar>← todos</button><h3>${esc(f.nome)}</h3></div>${navMes(mes)}</div>
        <div class="grid g3" style="margin:6px 0 10px">${kpi('Horas no mês', horasMin(e.total_minutos), `${e.dias_trabalhados} dia(s) trabalhado(s)`)}
          ${kpi('Jornada semanal', `${f.jornada_semanal ?? 44} h`, VINCULO[f.vinculo] || '')}
          ${kpi('Alertas', e.dias.filter(d => d.alerta).length, 'dias com batida faltando')}</div>
        <div class="cad-head"><span></span><button class="btn sm primary" data-ajuste>＋ Ajuste manual</button></div>
        <div class="table-wrap"><table><thead><tr><th>Dia</th><th>Batidas</th><th class="n">Horas</th><th>Alerta</th></tr></thead><tbody>
          ${e.dias.map(d => `<tr><td>${dmw(d.data)}</td><td>${d.batidas.map(b => `<span class="batida ${b.tipo}">
              ${b.tipo === 'entrada' ? '↘' : '↗'} ${b.local.slice(11, 16)}${b.origem === 'ajuste' ? ` <em title="${esc(b.motivo || '')}">ajuste</em>` : ''}
              ${b.tem_foto ? `<a href="/api/rh/ponto/${b.id}/foto" target="_blank" rel="noopener" title="Foto">📷</a>` : ''}
              ${b.lat ? `<a href="https://maps.google.com/?q=${b.lat},${b.lng}" target="_blank" rel="noopener" title="Localização (±${Math.round(b.precisao_m || 0)} m)">📍</a>` : ''}
              <button class="x" data-cancbat="${b.id}" title="Cancelar batida" aria-label="Cancelar batida">×</button></span>`).join('')}</td>
            <td class="n">${d.minutos ? horasMin(d.minutos) : '—'}</td><td>${d.alerta ? `<span class="neg">${esc(d.alerta)}</span>` : ''}</td></tr>`).join('')
            || '<tr><td colspan="4" class="muted">Nenhuma batida neste mês.</td></tr>'}
        </tbody></table></div></div>`;
      box.querySelector('[data-voltar]').onclick = () => irRH({ pessoa: '' });
      box.querySelector('[data-ajuste]').onclick = () => dialogoCad({ titulo: `Ajuste de ponto — ${f.nome}`,
        campos: [{ k: 'momento', rot: 'Data e hora', tipo: 'datetime-local', req: true, span: true },
                 { k: 'tipo', rot: 'Tipo', tipo: 'select', opcoes: [['entrada', 'Entrada'], ['saida', 'Saída']] },
                 { k: 'motivo', rot: 'Motivo (obrigatório)', req: true, span: true, ph: 'Ex.: esqueceu de bater a saída' }],
        nota: 'Ajustes ficam marcados como “ajuste” e guardam quem fez e o motivo.',
        salvar: d => send('POST', 'rh/ponto', { ...d, pessoa_id: p.pessoa }) });
      box.querySelectorAll('[data-cancbat]').forEach(b => b.onclick = async () => {
        if (!confirm('Cancelar esta batida? Ela sai do espelho (fica registrado quem cancelou).')) return;
        await send('POST', `rh/ponto/${b.dataset.cancbat}/cancelar`); render();
      });
    }
    box.querySelectorAll('[data-mesrh]').forEach(b => b.onclick = () => irRH({ mes: b.dataset.mesrh }));
  },

  async vales(box, p) {
    const mes = p.mes || mesAtual();
    const [l, funcs] = await Promise.all([api(`rh/lancamentos?mes=${mes}`), api('rh/funcionarios')]);
    const desc = l.filter(x => x.tipo !== 'bonus').reduce((s, x) => s + x.valor, 0);
    box.innerHTML = `<div class="card">
      <div class="graf-head"><h3>Vales, consumos e descontos</h3>${navMes(mes)}</div>
      <div class="sub">Lançados para descontar na folha do mês. O funcionário vê os dele no portal.</div>
      <div class="cad-head"><span class="muted">${l.length} lançamento(s) · a descontar ${money(desc)}</span><button class="btn sm primary" data-novo>＋ Lançar</button></div>
      ${table([
        { t: 'Funcionário', f: x => esc(x.nome) }, { t: 'Tipo', f: x => TIPO_LANC_RH[x.tipo] }, { t: 'Data', f: x => dm(x.data) },
        { t: 'Descrição', f: x => esc(x.descricao || '') }, { t: 'Valor', n: 1, f: x => money(x.valor) },
        { t: 'Situação', f: x => x.status === 'descontado' ? '<span class="ok-txt">Descontado</span>' : 'Pendente' },
        { t: '', f: x => `<button class="btn sm" data-st="${x.id}" data-v="${x.status === 'descontado' ? 'pendente' : 'descontado'}">${x.status === 'descontado' ? 'Reabrir' : 'Marcar descontado'}</button>
            <button class="ico-btn" data-canc="${x.id}" title="Cancelar" aria-label="Cancelar">×</button>` },
      ], l)}</div>`;
    box.querySelectorAll('[data-mesrh]').forEach(b => b.onclick = () => irRH({ mes: b.dataset.mesrh }));
    box.querySelector('[data-novo]').onclick = () => dialogoCad({ titulo: 'Lançar vale / consumo',
      campos: [{ k: 'pessoa_id', rot: 'Funcionário', tipo: 'select', span: true, opcoes: funcs.map(f => [f.pessoa_id, f.nome]) },
               { k: 'tipo', rot: 'Tipo', tipo: 'select', opcoes: Object.entries(TIPO_LANC_RH) },
               { k: 'data', rot: 'Data', tipo: 'date', req: true, padrao: hojeIso() },
               { k: 'valor', rot: 'Valor (R$)', tipo: 'money' },
               { k: 'competencia', rot: 'Descontar na folha de', tipo: 'month', padrao: mes },
               { k: 'descricao', rot: 'Descrição', span: true, ph: 'Ex.: consumo no salão, vale transporte' }],
      salvar: d => send('POST', 'rh/lancamentos', { ...d, competencia: d.competencia ? `${d.competencia}-01` : null }) });
    box.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => { await send('POST', `rh/lancamentos/${b.dataset.st}/status`, { status: b.dataset.v }); render(); });
    box.querySelectorAll('[data-canc]').forEach(b => b.onclick = async () => {
      if (!confirm('Cancelar este lançamento?')) return;
      await send('POST', `rh/lancamentos/${b.dataset.canc}/status`, { status: 'cancelado' }); render();
    });
  },

  async holerites(box, p) {
    const [docs, funcs] = await Promise.all([api('rh/documentos'), api('rh/funcionarios')]);
    box.innerHTML = `<div class="card"><h3>Enviar holerite ou documento</h3><div class="sub">PDF da contabilidade. Aparece no portal do funcionário, que pode baixar.</div>
        <form id="up-hol" class="filter-row">
          <label>Funcionário<select name="pessoa_id" required><option value="">Selecione…</option>${funcs.map(f => `<option value="${f.pessoa_id}">${esc(f.nome)}</option>`).join('')}</select></label>
          <label>Tipo<select name="tipo">${Object.entries(TIPO_DOC_RH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label>Competência<input type="month" name="competencia" value="${somaMes(mesAtual(), -1)}"></label>
          <label>Arquivo (PDF)<input type="file" name="arquivo" accept="application/pdf" required></label>
          <button class="btn primary">Enviar</button>
        </form><div class="dlg-err" hidden></div></div>
      <div class="card"><h3>Documentos enviados</h3>
        ${table([
          { t: 'Funcionário', f: d => esc(d.pessoa) }, { t: 'Tipo', f: d => TIPO_DOC_RH[d.tipo] },
          { t: 'Competência', f: d => d.competencia ? rotMes(d.competencia.slice(0, 7)) : '—' },
          { t: 'Arquivo', f: d => `<a href="/api/rh/documentos/${d.id}/arquivo" target="_blank" rel="noopener">${esc(d.nome)}</a>` },
          { t: 'Visto pelo funcionário', f: d => d.visto_em ? `<span class="ok-txt">${quando(d.visto_em)}</span>` : '<span class="muted">ainda não</span>' },
          { t: '', f: d => `<button class="ico-btn" data-canc="${d.id}" title="Remover" aria-label="Remover">×</button>` },
        ], docs)}</div>`;
    const f = box.querySelector('#up-hol');
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const err = box.querySelector('.dlg-err'); err.hidden = true;
      const r = await fetch('/api/rh/documentos', { method: 'POST', headers: { 'x-cockpit': '1' }, body: new FormData(f) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { err.hidden = false; err.textContent = erroDe(j, r.status); return; }
      FLASH = 'Documento enviado para o portal do funcionário.'; render();
    });
    box.querySelectorAll('[data-canc]').forEach(b => b.onclick = async () => {
      if (!confirm('Remover este documento do portal do funcionário?')) return;
      await send('POST', `rh/documentos/${b.dataset.canc}/cancelar`); render();
    });
  },
};

// ---------------------------------------------------------------- candidatos (banco de talentos)
const AREAS_CAND = { cozinha: 'Cozinha', salao: 'Salão', bar: 'Bar', caixa: 'Caixa', delivery: 'Delivery', limpeza: 'Limpeza', administrativo: 'Administrativo' };
const STATUS_CAND = { disponivel: 'Disponível', contratado: 'Contratado', sem_interesse: 'Sem interesse', nao_recomendado: 'Não recomendado' };
const ORIGENS_CAND = ['Indicação', 'Instagram', 'Site de vagas', 'Veio ao restaurante', 'Ex-funcionário', 'Free lance'];
const estrelas = n => n ? `<span class="estrelas" title="${n} de 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>` : '<span class="muted">—</span>';
const linkZap = tel => { const d = String(tel || '').replace(/\D/g, ''); return d.length >= 10 ? `https://wa.me/55${d.replace(/^55(?=\d{10,11}$)/, '')}` : null; };

async function abaCandidatos(box, p) {
  const todos = await api('rh/selecao');
  const area = AREAS_CAND[p.area] ? p.area : '', status = p.status === 'todos' || STATUS_CAND[p.status] ? p.status : 'disponivel';
  const lista = todos.filter(c => (!area || c.areas.includes(area)) && (status === 'todos' || c.status === status));
  const conta = (k, v) => todos.filter(c => (k === 'area' ? c.areas.includes(v) && (status === 'todos' || c.status === status) : (v === 'todos' || c.status === v) && (!area || c.areas.includes(area)))).length;
  box.innerHTML = `
    <div class="cad-head"><p class="sub">Pessoas que já passaram por processo seletivo. Quando abrir uma vaga, filtre pela área e chame pelo WhatsApp.</p>
      <button class="btn primary" data-novo>＋ Novo candidato</button></div>
    <div class="card filters"><div class="filter-row">
      <label>Área<select id="cd-area"><option value="">Todas as áreas</option>
        ${Object.entries(AREAS_CAND).map(([k, r]) => `<option value="${k}" ${k === area ? 'selected' : ''}>${r} (${conta('area', k)})</option>`).join('')}</select></label>
      <label>Situação<select id="cd-status">${[...Object.entries(STATUS_CAND), ['todos', 'Todas']].map(([k, r]) =>
        `<option value="${k}" ${k === status ? 'selected' : ''}>${r} (${conta('status', k)})</option>`).join('')}</select></label>
      <label>Buscar<input type="search" id="cd-q" placeholder="Nome, cidade ou observação"></label>
      <span class="muted" id="cd-n">${lista.length} candidato(s)</span>
    </div></div>
    <div class="card"><div class="table-wrap tall"><table><thead><tr><th>Nome</th><th>Áreas</th><th>Contato</th><th>Cidade</th>
      <th>Avaliação</th><th>Último contato</th><th>Currículo</th><th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map((c, i) => { const zap = linkZap(c.telefone); return `<tr data-busca="${esc(normBusca([c.nome, c.cidade, c.observacao, c.disponibilidade].join(' ')))}">
        <td><b>${esc(c.nome)}</b>${c.disponibilidade ? `<br><small class="muted">${esc(c.disponibilidade)}</small>` : ''}</td>
        <td>${c.areas.map(a => `<span class="chip-p">${AREAS_CAND[a]}</span>`).join(' ') || '—'}</td>
        <td>${zap ? `<a href="${zap}" target="_blank" rel="noopener" class="zap">${esc(fmtTelefone(c.telefone))}</a>` : esc(c.telefone || '—')}${c.email ? `<br><small class="muted">${esc(c.email)}</small>` : ''}</td>
        <td>${esc(c.cidade || '—')}</td><td>${estrelas(c.avaliacao)}</td><td>${c.ultimo_contato ? dm(c.ultimo_contato) + '/' + c.ultimo_contato.slice(2, 4) : '—'}</td>
        <td>${c.tem_curriculo ? `<a href="/api/rh/selecao/${c.id}/curriculo" target="_blank" rel="noopener">Abrir</a>` : '<span class="muted">—</span>'}</td>
        <td><span class="cand-st st-${c.status}">${STATUS_CAND[c.status]}</span></td>
        <td class="acoes"><button class="btn sm" data-edit="${i}">Editar</button></td></tr>`; }).join('')
        || `<tr><td colspan="9" class="muted">${todos.length ? 'Nenhum candidato com esses filtros.' : 'Nenhum candidato cadastrado ainda.'}</td></tr>`}
    </tbody></table></div></div>`;
  box.querySelector('#cd-area').onchange = e => irRH({ area: e.target.value });
  box.querySelector('#cd-status').onchange = e => irRH({ status: e.target.value });
  box.querySelector('#cd-q').oninput = e => {   // busca instantânea na lista já filtrada
    const t = normBusca(e.target.value.trim()); let n = 0;
    box.querySelectorAll('tbody tr[data-busca]').forEach(tr => { const ok = !t || tr.dataset.busca.includes(t); tr.hidden = !ok; n += ok; });
    box.querySelector('#cd-n').textContent = `${n} candidato(s)`;
  };
  box.querySelector('[data-novo]').onclick = () => painelCandidato(null, area);
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => painelCandidato(lista[b.dataset.edit]));
}

// doc: currículo vindo da Caixa de entrada (o arquivo é copiado de lá ao salvar)
function painelCandidato(c, areaInicial, doc) {
  const x = c || { status: 'disponivel', areas: areaInicial ? [areaInicial] : [], ultimo_contato: iso(new Date()) };
  let dr = document.getElementById('drawer');
  if (!dr) { dr = document.createElement('dialog'); dr.id = 'drawer'; document.body.appendChild(dr); }
  dr.className = 'drawer';
  dr.innerHTML = `<form class="drawer-body" autocomplete="off" novalidate>
    <div class="drawer-head"><div><div class="eyebrow">${c ? 'Candidato' : 'Novo candidato'}</div><h3>${c ? esc(c.nome) : 'Preencha os dados'}</h3></div>
      <button type="button" class="btn sm" data-fechar aria-label="Fechar">✕</button></div>
    <div class="drawer-campos">
      <label class="span2">Nome *<input name="nome" required maxlength="120" value="${esc(x.nome || '')}"></label>
      <label>Telefone / WhatsApp<input name="telefone" class="phone" type="tel" inputmode="tel" maxlength="15" value="${esc(fmtTelefone(x.telefone))}" placeholder="(00) 00000-0000"></label>
      <label>E-mail<input name="email" type="email" maxlength="120" value="${esc(x.email || '')}"></label>
      <label>Cidade<input name="cidade" maxlength="80" value="${esc(x.cidade || '')}" placeholder="Joaçaba"></label>
      <label>De onde veio<input name="origem" list="cd-origens" maxlength="80" value="${esc(x.origem || '')}" placeholder="Indicação, Instagram…">
        <datalist id="cd-origens">${ORIGENS_CAND.map(o => `<option value="${o}">`).join('')}</datalist></label>
      <fieldset class="checks span2"><legend>Áreas de interesse</legend>${Object.entries(AREAS_CAND).map(([k, r]) =>
        `<label><input type="checkbox" name="areas" value="${k}" ${x.areas.includes(k) ? 'checked' : ''}> ${r}</label>`).join('')}</fieldset>
      <label class="span2">Disponibilidade<input name="disponibilidade" maxlength="200" value="${esc(x.disponibilidade || '')}" placeholder="Ex.: noites e fins de semana"></label>
      <label>Pretensão salarial (R$)<input name="pretensao" class="money" inputmode="decimal" value="${fmtMoeda(x.pretensao)}" placeholder="0,00"></label>
      <label>Último contato<input name="ultimo_contato" type="date" value="${x.ultimo_contato || ''}"></label>
      <label>Avaliação<select name="avaliacao"><option value="">— Sem avaliação —</option>${[5, 4, 3, 2, 1].map(n =>
        `<option value="${n}" ${Number(x.avaliacao) === n ? 'selected' : ''}>${'★'.repeat(n)}${'☆'.repeat(5 - n)}</option>`).join('')}</select></label>
      <label>Situação<select name="status">${Object.entries(STATUS_CAND).map(([k, r]) => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="span2">Observações<textarea name="observacao" rows="3" maxlength="2000" placeholder="Como foi a entrevista, experiência, pontos fortes…">${esc(x.observacao || '')}</textarea></label>
      <label class="span2">Currículo <small>PDF, foto (JPG/PNG) ou Word, até 15 MB</small>
        ${c?.tem_curriculo ? `<span class="cv-atual">Atual: <a href="/api/rh/selecao/${c.id}/curriculo" target="_blank" rel="noopener">${esc(c.curriculo_nome || 'currículo')}</a> — escolha outro arquivo para substituir</span>` : ''}
        ${doc ? `<span class="cv-atual">Da Caixa de entrada: <a href="/api/inbox/${doc.id}/arquivo" target="_blank" rel="noopener">${esc(doc.nome)}</a></span>` : ''}
        <input name="arquivo" type="file" ${doc ? 'hidden' : ''} accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,application/pdf,image/jpeg,image/png"></label>
    </div>
    <div class="dlg-err" hidden></div>
    <div class="drawer-foot"><div>${c ? '<button type="button" class="btn perigo" data-excluir>Excluir</button>' : ''}</div>
      <div class="actions"><button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn primary">Salvar</button></div></div>
  </form>`;
  const f = dr.querySelector('form'), err = dr.querySelector('.dlg-err');
  let sujo = false;
  f.addEventListener('input', () => { sujo = true; });
  const fechar = () => { if (!sujo || confirm('Descartar as alterações não salvas?')) dr.close(); };
  dr.oncancel = e => { e.preventDefault(); fechar(); };
  dr.onclose = null;
  dr.onclick = async e => {
    if (e.target.closest('[data-fechar]')) fechar();
    if (e.target.closest('[data-excluir]')) {
      if (!confirm(`Excluir ${c.nome} do banco de candidatos? O currículo também será apagado.`)) return;
      try { await send('DELETE', `rh/selecao/${c.id}`); dr.close(); FLASH = `${c.nome} foi excluído.`; render(); }
      catch (ex) { err.hidden = false; err.textContent = ex.message; }
    }
  };
  f.onsubmit = async e => {
    e.preventDefault(); err.hidden = true;
    const btn = f.querySelector('[type=submit]');
    const v = n => f.elements[n].value.trim();
    if (!v('nome')) { err.hidden = false; err.textContent = 'Informe o nome.'; return; }
    const corpo = { nome: v('nome'), telefone: v('telefone') || null, email: v('email') || null, cidade: v('cidade') || null,
      origem: v('origem') || null, areas: [...f.querySelectorAll('[name=areas]:checked')].map(i => i.value),
      disponibilidade: v('disponibilidade') || null, pretensao: v('pretensao') ? lerMoeda(v('pretensao')) : null,
      ultimo_contato: v('ultimo_contato') || null, avaliacao: v('avaliacao') ? Number(v('avaliacao')) : null,
      status: v('status'), observacao: v('observacao') || null };
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      const r = c ? await send('PUT', `rh/selecao/${c.id}`, corpo) : await send('POST', 'rh/selecao', corpo);
      c = c || { id: r.id, nome: r.nome };   // se o currículo falhar, o próximo Salvar edita em vez de duplicar
      const arq = f.elements.arquivo.files[0];
      if (arq) {
        const fd = new FormData(); fd.append('arquivo', arq);
        const up = await fetch(`/api/rh/selecao/${r.id}/curriculo`, { method: 'POST', headers: { 'x-cockpit': '1' }, body: fd });
        if (!up.ok) throw new Error(`Dados salvos, mas o currículo não foi anexado: ${erroDe(await up.json().catch(() => ({})), up.status)}`);
      } else if (doc) {
        try { await send('POST', `rh/selecao/${r.id}/curriculo-do-documento/${doc.id}`); }
        catch (ex) { throw new Error(`Dados salvos, mas o currículo não foi anexado: ${ex.message}`); }
        dr.close(); FLASH = `${esc(corpo.nome)} entrou em RH › Candidatos com o currículo. Saiu da caixa de entrada.`;
        atualizarBadgeInbox(); return render();
      }
      dr.close(); FLASH = `${corpo.nome} salvo.`; render();
    } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Salvar'; }
  };
  dr.showModal();
  if (!c) f.elements.nome.focus();
}
ABA_RH.candidatos = abaCandidatos;

// ---------------------------------------------------------------- free lances: chamar rápido pelo WhatsApp
const msgFlPadrao = () => `Oi {nome}, tudo bem? Aqui é do ${nomeEmpresa()}. Você consegue fazer um free lance {dia}, {turno}?`;
const TURNOS_FL = { 'à noite': 'Noite', 'no almoço': 'Almoço', 'o dia todo': 'Dia todo' };
const primeiroNome = n => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); };
const lerLocal = (k, padrao) => { try { return localStorage.getItem(k) ?? padrao; } catch { return padrao; } };
const gravarLocal = (k, v) => { try { localStorage.setItem(k, v); } catch { /* navegador sem armazenamento: só não lembra */ } };

async function abaFreeLances(box) {
  const equipe = await api('cad/pessoas?area=equipe');
  const fl = equipe.filter(x => x.ativo && x.papeis.includes('free_lance'));
  const grupos = [['salao', 'Salão'], ['cozinha', 'Cozinha']].map(([k, rot]) => [rot, fl.filter(x => (x.free_lance_areas || []).includes(k))]);
  const semArea = fl.filter(x => !(x.free_lance_areas || []).length);
  if (semArea.length) grupos.push(['Área não definida', semArea]);
  const hoje = iso(new Date());
  box.innerHTML = `
    <div class="cad-head"><p class="sub">Free lances ativos da Equipe. Escolha o dia e o turno, e o botão abre o WhatsApp de cada um já com a mensagem escrita.</p>
      <a class="btn" href="#/cadastros?aba=equipe&funcao=free_lance">Editar cadastro dos free lances</a></div>
    <div class="card fl-msg">
      <div class="filter-row">
        <label>Dia<input type="date" id="fl-dia" value="${hoje}" min="${hoje}"></label>
        <label>Turno<select id="fl-turno">${Object.entries(TURNOS_FL).map(([v, r]) => `<option value="${v}">${r}</option>`).join('')}</select></label>
        <label class="fl-texto">Mensagem <small>{nome}, {dia} e {turno} são trocados automaticamente</small>
          <textarea id="fl-txt" rows="2" maxlength="600">${esc(lerLocal('fl_msg', msgFlPadrao()))}</textarea></label>
      </div>
      <p class="fl-previa" id="fl-previa"></p>
      <button type="button" class="link-btn" id="fl-padrao">Voltar para a mensagem padrão</button>
    </div>
    ${fl.length ? grupos.filter(([, xs]) => xs.length).map(([rot, xs]) => `<section class="ce-grupo"><h4>${rot} · ${xs.length}</h4><div class="fl-cards">
      ${xs.map(x => `<div class="fl-card">
        <div><b>${esc(x.nome)}</b>
          <small>${(x.free_lance_areas || []).map(a => a === 'salao' ? 'Salão' : 'Cozinha').join(' e ') || 'área não definida'}${x.diaria_padrao != null ? ` · diária ${money(x.diaria_padrao)}` : ''}</small>
          <small>${esc(fmtTelefone(x.telefone) || 'sem telefone')}</small></div>
        ${linkZap(x.telefone) ? `<a class="btn zap-btn" data-zap="${esc(x.telefone)}" data-nome="${esc(x.nome)}" target="_blank" rel="noopener">WhatsApp</a>`
          : '<a class="btn sm" href="#/cadastros?aba=equipe&funcao=free_lance">Cadastrar telefone</a>'}
      </div>`).join('')}</div></section>`).join('')
      : '<div class="card empty">Nenhum free lance ativo. Cadastre em Cadastros › Pessoas › Equipe, marcando "Free lance cozinha" ou "Free lance salão".</div>'}`;

  const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const diaTxt = d => {
    if (!d) return 'hoje';
    const dt = parseD(d), dif = Math.round((dt - parseD(hoje)) / 86400000);
    return `${dif === 0 ? 'hoje' : dif === 1 ? 'amanhã' : DIAS[dt.getDay()]} (${dm(d)})`;
  };
  const montar = nome => box.querySelector('#fl-txt').value
    .replaceAll('{nome}', primeiroNome(nome)).replaceAll('{dia}', diaTxt(box.querySelector('#fl-dia').value))
    .replaceAll('{turno}', box.querySelector('#fl-turno').value);
  const atualizar = () => {
    box.querySelectorAll('[data-zap]').forEach(a => { a.href = `${linkZap(a.dataset.zap)}?text=${encodeURIComponent(montar(a.dataset.nome))}`; });
    box.querySelector('#fl-previa').textContent = `Prévia: ${montar(fl[0]?.nome || 'Fulano')}`;
  };
  box.querySelector('.fl-msg').addEventListener('input', e => { if (e.target.id === 'fl-txt') gravarLocal('fl_msg', e.target.value); atualizar(); });
  box.querySelector('.fl-msg').addEventListener('change', atualizar);
  box.querySelector('#fl-padrao').onclick = () => { box.querySelector('#fl-txt').value = msgFlPadrao(); gravarLocal('fl_msg', msgFlPadrao()); atualizar(); };
  atualizar();
}
ABA_RH.freelances = abaFreeLances;

PAGES['rh'] = {
  eyebrow: 'Gestão de pessoas', title: 'RH', lede: 'Funcionários, free lances, ponto, vales, holerites e candidatos.', periodo: false,
  async render(v, p) {
    const aba = ABA_RH[p.aba] ? p.aba : 'funcionarios';
    const flash = FLASH; FLASH = '';
    v.innerHTML = `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      <section id="rh-box" class="view"></section>`;
    await ABA_RH[aba](v.querySelector('#rh-box'), p);
  },
};
