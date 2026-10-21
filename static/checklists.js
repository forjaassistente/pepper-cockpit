// Checklists de rotina: a equipe marca item por item (#/checklist?id=&d=); o admin monta em Lista de tarefas › Checklists.
// Itens não feitos (com motivo) ou checklist não finalizado viram aviso na Lista de tarefas do admin. Servidor: checklists.py.

const DIAS_CK = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const ST_CK = { ok: ['ok', 'tudo feito'], pendencia: ['pend', 'com pendência'], nao_feito: ['nao', 'não feito'], andamento: ['and', 'em andamento'], folga: ['folga', 'não vale'] };

// ---------------------------------------------------------------- fazer o checklist (celular)
PAGES['checklist'] = {
  eyebrow: 'Rotina', title: 'Checklist', lede: 'Marque cada item quando fizer.', periodo: false,
  async render(v, p) {
    const r = await api(`portal/checklists/${p.id}/dia/${p.d}`);
    const e = r.execucao, admin = ehAdmin();
    document.getElementById('title').textContent = r.checklist.nome;
    const dObj = parseD(r.data);
    document.getElementById('lede').textContent = `${['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][dObj.getDay()]}, ${dm(r.data)}`
      + (r.checklist.descricao ? ` · ${r.checklist.descricao}` : '');
    const flash = FLASH; FLASH = '';
    const faltam = () => r.itens.filter(i => !i.feito_em).length;
    v.innerHTML = `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
      ${e.finalizada_em ? `<div class="alert ${e.feitos >= e.total ? 'ok' : 'warn'}">Finalizado por ${esc(e.finalizada_por_nome || '—')}
          em ${new Date(e.finalizada_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.
          ${e.motivo ? `<br><b>Motivo do que ficou sem fazer:</b> ${esc(e.motivo)}` : ''}</div>`
        : !r.editavel ? '<div class="alert warn">Este dia já passou e o checklist não foi finalizado.</div>' : ''}
      <div class="card ck-card">
        <div class="ct-barra"><span id="ck-bar"></span></div>
        <div class="muted small-txt" id="ck-prog"></div>
        <div class="ck-itens">${r.itens.map(i => `<label class="ck-item ${i.feito_em ? 'ok' : ''}" data-id="${i.id}">
            <input type="checkbox" ${i.feito_em ? 'checked' : ''} ${r.editavel ? '' : 'disabled'}>
            <span class="ck-box" aria-hidden="true"></span>
            <span class="ck-txt">${esc(i.texto)}${i.feito_em && i.feito_por_nome ? `<small>${esc(i.feito_por_nome)} · ${new Date(i.feito_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>` : ''}</span>
          </label>`).join('')}</div>
      </div>
      ${r.editavel ? `<div class="card ck-fim">
          <label id="ck-motivo-box" hidden>O que ficou sem fazer e por quê? <small>(vai para o administrador)</small>
            <textarea id="ck-motivo" rows="2" maxlength="1000" placeholder="Ex.: faltou pano de chão; mise en place do bacon fica para amanhã"></textarea></label>
          <div class="dlg-err" id="ck-err" hidden></div>
          <div class="actions" style="justify-content:space-between"><a class="btn" href="#/afazeres">Voltar</a><button class="btn primary" id="ck-finalizar">Finalizar checklist</button></div>
        </div>` : `<div class="actions" style="justify-content:space-between;margin-top:8px"><a class="btn" href="#/afazeres">Voltar</a>
          ${admin && !e.ciente_em && (e.finalizada_em ? e.feitos < e.total : true) ? '<button class="btn primary" id="ck-ciente">Ciente — tirar da minha lista</button>' : ''}</div>`}`;
    const prog = () => {
      const n = r.itens.length - faltam();
      v.querySelector('#ck-prog').textContent = `${n} de ${r.itens.length} itens feitos`;
      v.querySelector('#ck-bar').style.width = `${r.itens.length ? n / r.itens.length * 100 : 0}%`;
      const mb = v.querySelector('#ck-motivo-box');
      if (mb) mb.hidden = !faltam();
    };
    v.querySelectorAll('.ck-item input').forEach(cb => cb.onchange = async () => {
      const lab = cb.closest('.ck-item'), it = r.itens.find(i => i.id === lab.dataset.id);
      lab.classList.add('salvando');
      try {
        await send('PUT', `portal/checklists/${r.checklist.id}/dia/${r.data}/itens/${it.id}`, { feito: cb.checked });
        it.feito_em = cb.checked ? new Date().toISOString() : null;
        lab.classList.toggle('ok', cb.checked);
      } catch (ex) { cb.checked = !cb.checked; alert(ex.message); }
      lab.classList.remove('salvando'); prog();
    });
    v.querySelector('#ck-finalizar')?.addEventListener('click', async () => {
      const err = v.querySelector('#ck-err'); err.hidden = true;
      const motivo = v.querySelector('#ck-motivo').value.trim();
      if (faltam() && !motivo) { err.hidden = false; err.textContent = `${faltam()} item(ns) sem marcar: conte o motivo para o administrador.`; v.querySelector('#ck-motivo').focus(); return; }
      try {
        const x = await send('POST', `portal/checklists/${r.checklist.id}/dia/${r.data}/finalizar`, { motivo: motivo || null });
        FLASH = x.faltaram ? `Checklist finalizado. ${x.faltaram} item(ns) não feito(s) foram avisados ao administrador.` : 'Checklist finalizado. Tudo feito ✓';
        atualizarBadgeAfazeres(); location.hash = '#/afazeres';
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    });
    v.querySelector('#ck-ciente')?.addEventListener('click', async () => {
      await send('POST', `portal/checklists/${r.checklist.id}/dia/${r.data}/ciente`);
      FLASH = 'Aviso marcado como visto.'; atualizarBadgeAfazeres(); location.hash = '#/afazeres';
    });
    prog();
  },
};

// ---------------------------------------------------------------- montar os checklists (admin)
async function abaChecklists(box) {
  const r = await api('portal/checklists/admin');
  box.innerHTML = `
    <div class="cad-head"><p class="sub">Rotinas que a equipe marca item por item (abertura, fechamento...). Cada dia em que o checklist vale,
      ele aparece na Lista de tarefas de quem faz. Item não feito ou checklist não finalizado vira aviso na sua lista.</p>
      <button class="btn primary" id="ck-novo">＋ Novo checklist</button></div>
    ${r.checklists.length ? r.checklists.map(c => `<div class="card ck-adm ${c.ativo ? '' : 'arq'}">
        <div class="graf-head"><div><h3>${esc(c.nome)}${c.ativo ? '' : ' <span class="ce-tag">arquivado</span>'}</h3>
          <div class="sub">${c.dias_semana.length === 7 ? 'Todos os dias' : c.dias_semana.map(d => DIAS_CK[d]).join(', ')} ·
            ${c.itens.length} itens · ${c.pessoas.length ? esc(c.pessoas.map(p => p.nome).join(', ')) : '<span class="neg">ninguém escalado</span>'}</div></div>
          <button class="btn sm" data-editar="${c.id}">Editar</button></div>
        <div class="ck-semana">${c.semana.map(s => `<a class="ck-dia st-${ST_CK[s.st][0]}" ${s.st === 'folga' ? '' : `href="#/checklist?id=${c.id}&d=${s.data}"`}
            title="${dm(s.data)} · ${ST_CK[s.st][1]}${s.total ? ` (${s.feitos}/${s.total})` : ''}"><small>${DIAS_CK[parseD(s.data).getDay()]}</small>${dm(s.data).slice(0, 2)}</a>`).join('')}</div>
      </div>`).join('') : '<div class="card empty">Nenhum checklist ainda. Crie o primeiro (ex.: “Abertura da cozinha”).</div>'}
    <p class="muted small-txt ck-leg"><i class="st-ok"></i>tudo feito <i class="st-pend"></i>com pendência <i class="st-nao"></i>não feito <i class="st-and"></i>em andamento</p>`;
  const editar = c => {
    const x = c || { nome: '', descricao: '', dias_semana: [0, 1, 2, 3, 4, 5, 6], ativo: true, itens: [], pessoas: [] };
    const dlg = document.getElementById('dlg');
    dlg.className = 'dlg largo';
    dlg.innerHTML = `<form method="dialog" class="dlg-body ck-form">
      <h3>${c ? `Editar ${esc(c.nome)}` : 'Novo checklist'}</h3>
      <label>Nome *<input name="nome" required maxlength="100" value="${esc(x.nome)}" placeholder="Ex.: Abertura da cozinha"></label>
      <label>Observação <small>(aparece no topo do checklist)</small><input name="descricao" maxlength="500" value="${esc(x.descricao || '')}" placeholder="Ex.: fazer até as 18h"></label>
      <fieldset class="checks"><legend>Dias em que vale</legend>${DIAS_CK.map((d, i) =>
        `<label><input type="checkbox" name="dia" value="${i}" ${x.dias_semana.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</fieldset>
      <fieldset class="checks ck-pessoas"><legend>Quem faz <small>(aparece na Lista de tarefas dessas pessoas)</small></legend>
        ${r.pessoas.map(p => `<label><input type="checkbox" name="pessoa" value="${p.id}" ${x.pessoas.some(y => y.id === p.id) ? 'checked' : ''}> ${esc(p.nome)}</label>`).join('')}
        ${r.pessoas.length < 2 ? '<small class="muted">Só aparecem pessoas com login no app (RH › Funcionários › Acesso).</small>' : ''}</fieldset>
      <label>Itens * <small>(um por linha, na ordem em que são feitos)</small>
        <textarea name="itens" rows="9" placeholder="Fritar os bacons&#10;Preparar o mise en place&#10;Conferir validade dos molhos">${esc(x.itens.map(i => i.texto).join('\n'))}</textarea></label>
      ${c ? `<label class="check-l"><input type="checkbox" name="ativo" ${x.ativo ? 'checked' : ''}> Ativo (desmarque para arquivar)</label>` : ''}
      <div class="dlg-err" hidden></div>
      <div class="actions">${c ? '<button type="button" class="btn perigo" data-excluir style="margin-right:auto">Excluir</button>' : ''}
        <button value="cancel" class="btn" formnovalidate>Cancelar</button><button value="ok" class="btn primary">Salvar</button></div>
    </form>`;
    const f = dlg.querySelector('form'), err = dlg.querySelector('.dlg-err');
    f.addEventListener('submit', async ev => {
      if (ev.submitter?.value !== 'ok') return;
      ev.preventDefault(); err.hidden = true;
      const corpo = { nome: f.nome.value.trim(), descricao: f.descricao.value.trim() || null,
        dias_semana: [...f.querySelectorAll('[name=dia]:checked')].map(i => Number(i.value)),
        pessoas: [...f.querySelectorAll('[name=pessoa]:checked')].map(i => i.value),
        itens: f.itens.value.split('\n').map(t => t.trim()).filter(Boolean), ativo: c ? f.ativo.checked : true };
      if (!corpo.dias_semana.length) { err.hidden = false; err.textContent = 'Escolha pelo menos um dia.'; return; }
      if (!corpo.itens.length) { err.hidden = false; err.textContent = 'Coloque pelo menos um item.'; return; }
      try {
        await send(c ? 'PUT' : 'POST', `portal/checklists/admin${c ? `/${c.id}` : ''}`, corpo);
        dlg.close(); FLASH = `Checklist “${corpo.nome}” salvo.`; atualizarBadgeAfazeres(); render();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    });
    dlg.querySelector('[data-excluir]')?.addEventListener('click', async () => {
      if (!confirm(`Excluir o checklist “${c.nome}” e todo o histórico dele? Para só parar de usar, desmarque “Ativo”.`)) return;
      await send('DELETE', `portal/checklists/admin/${c.id}`);
      dlg.close(); FLASH = 'Checklist excluído.'; atualizarBadgeAfazeres(); render();
    });
    dlg.showModal();
  };
  box.querySelector('#ck-novo').onclick = () => editar(null);
  box.querySelectorAll('[data-editar]').forEach(b => b.onclick = () => editar(r.checklists.find(c => c.id === b.dataset.editar)));
}
