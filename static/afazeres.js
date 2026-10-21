// Lista de tarefas: o que o sistema pede (com botão para ir fazer) + tarefas criadas à mão.
// O admin também atribui tarefas a pessoas da equipe e acompanha. Servidor: afazeres.py.

const ICONE_AFAZER = { caixa_conferir: '▣', caixa_fechar: '▣', nota_conciliar: '✉', inbox: '✉', estoque: '▥', checklist: '☑', checklist_aviso: '!' };
const REPETE = { diaria: 'todo dia', semanal: 'toda semana', mensal: 'todo mês' };

async function atualizarBadgeAfazeres() {
  const b = document.getElementById('afazeres-badge');
  if (!b || !USUARIO) return;
  try { const r = await api('portal/afazeres/contagem'); b.textContent = r.n; b.hidden = !r.n; } catch { /* sem rede: mantém */ }
}

const DIAS_AF = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
// coluna de data da linha (como no Resumo do caixa): "hoje", "amanhã", "qua 22/10", "sem prazo"
function dataTarefa(d, hoje) {
  if (!d) return '<span class="muted">sem prazo</span>';
  const dt = parseD(d), dif = Math.round((dt - parseD(hoje)) / 86400000);
  const rot = dif === 0 ? 'hoje' : dif === 1 ? 'amanhã' : dif === -1 ? 'ontem' : `${DIAS_AF[dt.getDay()]} ${dm(d)}`;
  return `<span class="${dif < 0 ? 'neg' : dif === 0 ? 'af-hoje' : ''}">${rot}</span>`;
}

// formulário de nova tarefa / edição (o admin escolhe para quem)
async function dialogoTarefa(t) {
  const admin = ehAdmin();
  const pessoas = admin ? await api('portal/afazeres/pessoas') : [];
  const campos = [
    ...(admin ? [{ k: 'responsavel_id', rot: 'Para quem *', tipo: 'select', span: true,
      opcoes: pessoas.map(p => [p.id, p.id === USUARIO.id ? `Eu (${p.nome})` : `${p.nome} · ${ROT_PERFIL[p.perfil] || p.perfil}`]) }] : []),
    { k: 'titulo', rot: 'O que precisa ser feito *', req: true, span: true, max: 200, ph: 'Ex.: Ligar para o fornecedor de embalagens' },
    { k: 'descricao', rot: 'Detalhes', tipo: 'textarea' },
    { k: 'prazo', rot: 'Prazo', tipo: 'date', ajuda: 'Para tarefa que se repete: a data da próxima vez (vazio = hoje).' },
    { k: 'recorrencia', rot: 'Repetir', tipo: 'select', opcoes: [['', 'Não repete'], ['diaria', 'Todo dia'], ['semanal', 'Toda semana'], ['mensal', 'Todo mês']],
      ajuda: 'Ao marcar como feita, a próxima é criada sozinha.' },
  ];
  dialogoCad({ titulo: t ? 'Editar tarefa' : 'Nova tarefa', campos,
    valores: t ? { ...t, recorrencia: t.recorrencia || '' } : { responsavel_id: USUARIO.id },
    nota: admin && !t ? 'Escolha você mesmo ou alguém da equipe. Só aparecem pessoas com login no app (RH › Funcionários › Acesso).' : '',
    salvar: d => send(t ? 'PUT' : 'POST', `portal/afazeres${t ? `/${t.id}` : ''}`,
      { ...d, responsavel_id: d.responsavel_id || null, recorrencia: d.recorrencia || null }),
    depois: () => { FLASH = t ? 'Tarefa atualizada.' : 'Tarefa criada.'; atualizarBadgeAfazeres(); render(); } });
}

PAGES['afazeres'] = {
  eyebrow: 'Rotina', title: 'Lista de tarefas', lede: 'O que precisa ser feito — do sistema e da equipe.', periodo: false,
  async render(v, p) {
    if (ehAdmin() && p.aba === 'checklists') {   // o admin monta os checklists na mesma área
      document.getElementById('title').textContent = 'Checklists';
      const flash = FLASH; FLASH = '';
      v.innerHTML = `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}<section id="ck-box" class="view"></section>`;
      return abaChecklists(v.querySelector('#ck-box'));
    }
    const r = await api('portal/afazeres');
    const hoje = r.hoje, admin = ehAdmin();
    const flash = FLASH; FLASH = '';
    const auto = r.automaticos;
    const todas = [...r.minhas, ...r.equipe];
    // linha da lista: data | tarefa | ações
    const linha = (t, equipe) => {
      const feita = !!t.concluida_em, minha = t.responsavel_id === USUARIO.id;
      const podeEditar = admin || t.criado_por === USUARIO.id;
      const info = [t.recorrencia ? `<span class="af-rep">↻ ${REPETE[t.recorrencia]}</span>` : '',
        equipe ? `<span>para ${esc(t.responsavel_nome)}</span>` : '',
        minha && t.criado_por_nome && t.criado_por !== USUARIO.id ? `<span>pedida por ${esc(t.criado_por_nome)}</span>` : '',
        feita ? `<span>feita${t.concluida_por_nome ? ` por ${esc(t.concluida_por_nome)}` : ''}</span>` : ''].filter(Boolean).join('');
      return `<div class="tf-row ${feita ? 'feita' : ''}" data-id="${t.id}">
        <div class="tf-d">${feita ? `<span>${dm(t.concluida_em.slice(0, 10))}</span><small>${new Date(t.concluida_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>`
          : dataTarefa(t.prazo, hoje)}</div>
        <div class="tf-n"><b>${esc(t.titulo)}</b>${t.descricao ? `<p>${esc(t.descricao)}</p>` : ''}${info ? `<small>${info}</small>` : ''}</div>
        <div class="tf-acoes">
          ${feita ? '<button type="button" class="btn sm" data-concluir="desfazer" title="Voltar para em aberto">Desfazer</button>'
            : '<button type="button" class="af-check" data-concluir="sim" title="Marcar como feita" aria-label="Marcar como feita"></button>'}
          ${podeEditar && !feita ? '<button type="button" class="ico-btn" data-editar title="Editar tarefa" aria-label="Editar tarefa">✎</button>' : ''}
          ${podeEditar ? '<button type="button" class="ico-btn" data-excluir title="Excluir tarefa" aria-label="Excluir tarefa">×</button>' : ''}
        </div></div>`;
    };
    const vazio = txt => `<p class="muted small-txt tf-vazio">${txt}</p>`;
    // cartão com abas, como "Recebimentos / Pagamentos" no Resumo
    const cartao = (id, titulo, lista, equipe) => {
      const atrasadas = lista.filter(t => t.prazo && t.prazo < hoje);
      const proximas = lista.filter(t => !t.prazo || t.prazo >= hoje);
      return `<div class="card tit-card tf-card" data-card="${id}">
        <h3 class="tit-h">${titulo}</h3>
        <div class="tit-tabs" role="tablist">
          <button type="button" class="on" data-f="proximas" role="tab" aria-selected="true">Próximas <b>${proximas.length}</b></button>
          <button type="button" data-f="atrasadas" role="tab" aria-selected="false">Atrasadas <b class="${atrasadas.length ? 'neg' : ''}">${atrasadas.length}</b></button>
          <button type="button" data-f="realizadas" role="tab" aria-selected="false">Realizadas</button>
        </div>
        <div class="tit-list tf-list" data-lista="proximas">${proximas.map(t => linha(t, equipe)).join('') || vazio('Nada em aberto.')}</div>
        <div class="tit-list tf-list" data-lista="atrasadas" hidden>${atrasadas.map(t => linha(t, equipe)).join('') || vazio('Nenhuma tarefa atrasada.')}</div>
        <div class="tit-list tf-list" data-lista="realizadas" data-quem="${id}" hidden><div class="loading">Carregando…</div></div>
      </div>`;
    };
    v.innerHTML = `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      <div class="cad-head"><p class="sub">${auto.length + r.minhas.length ? `Você tem <b>${auto.length + r.minhas.length}</b> tarefa(s) para fazer.` : 'Tudo em dia por aqui.'}</p>
        <button class="btn primary" id="af-nova">＋ Nova tarefa${admin ? ' (sua ou da equipe)' : ''}</button></div>
      <div class="card af-bloco"><h3>Do sistema</h3><div class="sub">Aparecem sozinhas e somem quando a coisa é feita.</div>
        ${auto.length ? auto.map(a => `<div class="af-item auto ${a.urgente ? 'urgente' : ''}">
            <span class="af-ico" aria-hidden="true">${ICONE_AFAZER[a.tipo] || '•'}</span>
            <div class="af-txt"><b>${esc(a.titulo)}</b><small>${esc(a.detalhe || '')}${a.urgente ? ' <span class="af-prazo atrasada">pendente</span>' : ''}</small></div>
            <a class="btn sm primary" href="${a.link}">${esc(a.acao)} →</a></div>`).join('')
          : '<p class="muted small-txt">Nada pendente do sistema.</p>'}
      </div>
      <div class="grid ${admin ? 'g-1-1' : ''} tf-grid">${cartao('minhas', 'Minhas tarefas', r.minhas, false)}
        ${admin ? cartao('equipe', 'Tarefas da equipe', r.equipe, true) : ''}</div>`;

    v.querySelector('#af-nova').onclick = () => dialogoTarefa(null);
    v.querySelectorAll('.tf-card .tit-tabs button').forEach(b => b.onclick = async () => {
      const card = b.closest('.tf-card');
      card.querySelectorAll('.tit-tabs button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
      card.querySelectorAll('[data-lista]').forEach(l => { l.hidden = l.dataset.lista !== b.dataset.f; });
      const real = card.querySelector('[data-lista="realizadas"]');
      if (b.dataset.f === 'realizadas' && !real.dataset.ok) {   // histórico carregado só quando abre a aba
        const feitas = await api(`portal/afazeres/realizadas?quem=${real.dataset.quem}&dias=90`);
        feitas.forEach(t => todas.push(t));
        real.dataset.ok = '1';
        real.innerHTML = feitas.map(t => linha(t, real.dataset.quem === 'equipe')).join('') || vazio('Nenhuma tarefa feita nos últimos 90 dias.');
      }
    });
    v.onclick = async e => {
      const item = e.target.closest('.tf-row[data-id]');
      if (!item) return;
      const t = todas.find(x => x.id === item.dataset.id);
      try {
        const c = e.target.closest('[data-concluir]');
        if (c) {
          const x = await send('POST', `portal/afazeres/${t.id}/concluir${c.dataset.concluir === 'desfazer' ? '?desfazer=true' : ''}`);
          FLASH = x.proxima ? `Feito! A próxima ficou para ${dm(x.proxima)}.` : c.dataset.concluir === 'desfazer' ? 'Tarefa voltou para em aberto.' : 'Feito ✓';
          atualizarBadgeAfazeres(); render();
        }
        if (e.target.closest('[data-editar]')) dialogoTarefa(t);
        if (e.target.closest('[data-excluir]')) {
          if (!confirm(`Excluir “${t.titulo}”?${t.recorrencia ? ' Ela para de se repetir.' : ''}`)) return;
          await send('DELETE', `portal/afazeres/${t.id}`);
          FLASH = 'Tarefa excluída.'; atualizarBadgeAfazeres(); render();
        }
      } catch (ex) { alert(ex.message); }
    };
  },
};
