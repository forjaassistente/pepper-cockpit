// Leitor de boleto no "Novo lançamento": envia PDF/foto, mostra o documento com cada palavra
// clicável e deixa escolher para qual campo vai o que foi selecionado. Usa fin.js e app.js.

const CAMPOS = {
  vencimento: { rot: 'Vencimento', input: 'vencimento' },
  competencia: { rot: 'Competência', input: 'competencia' },
  valor: { rot: 'Valor', input: 'valor' },
  fornecedor: { rot: 'Fornecedor', input: 'contato' },
  descricao: { rot: 'Descrição', input: 'descricao' },
};
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function lerData(txt) {
  const m = txt.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (!m) return null;
  const a = m[3].length === 2 ? `20${m[3]}` : m[3];
  const d = `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isNaN(parseD(d)) ? null : d;
}

function lerCompetencia(txt) {
  const completa = lerData(txt);
  if (completa) return completa;
  let m = txt.match(/(\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}-01`;
  m = txt.toLowerCase().match(/(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*[\s/.-]*(?:de\s+)?(\d{4})/);
  if (m) return `${m[2]}-${String(MESES.indexOf(m[1]) + 1).padStart(2, '0')}-01`;
  return null;
}

function lerValor(txt) {
  const achados = txt.match(/\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2}|\d+\.\d{2}(?!\d)/g);
  if (!achados) return null;
  const s = achados[achados.length - 1];
  return s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
}

function novoLeitor(v) {
  const leitor = v.querySelector('#leitor');
  const f = () => v.querySelector('#flanc');
  let doc = null;
  const sel = new Set();
  const marcas = {};

  const vazio = (msg = '') => {
    doc = null; sel.clear();
    Object.keys(marcas).forEach(k => delete marcas[k]);
    if (f()) delete f().dataset.anexo;
    leitor.innerHTML = `
      <label class="drop">
        <input type="file" accept="application/pdf,image/*,.heic" hidden>
        <span class="drop-ico">⇪</span>
        <b>Ler boleto ou cobrança</b>
        <span>Arraste aqui um PDF ou uma foto, ou clique para escolher.<br>Valor e vencimento saem da linha digitável; o resto a IA sugere e você confere.</span>
      </label>
      ${msg ? `<div class="alert">${esc(msg)}</div>` : ''}`;
    const input = leitor.querySelector('input');
    input.onchange = () => input.files[0] && enviar(input.files[0]);
    const drop = leitor.querySelector('.drop');
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && enviar(e.dataTransfer.files[0]); };
  };

  async function ler(nome, requisicao) {
    leitor.innerHTML = `<div class="lendo"><div class="spin"></div><b>Lendo ${esc(nome)}…</b><span>OCR e IA podem levar de 10 a 40 segundos.</span></div>`;
    try {
      const r = await requisicao();
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(erroDe(j, r.status));
      doc = j;
      desenhar();
      aplicarSugestoes();
    } catch (e) {
      vazio(e.message);
    }
  }
  function enviar(arquivo) {
    const fd = new FormData();
    fd.append('arquivo', arquivo);
    return ler(arquivo.name, () => fetch('/api/fin/anexos', { method: 'POST', headers: { 'x-cockpit': '1' }, body: fd }));
  }

  const texto = ids => doc.palavras.filter(w => ids.includes(w.id)).map(w => w.t).join(' ');

  function desenhar() {
    const ia = doc.ia || {};
    leitor.innerHTML = `
      <div class="leitor-head">
        <div><b>${esc(doc.nome)}</b> <span class="muted">· ${doc.palavras.length} palavras${doc.paginas.some(p => p.origem === 'ocr') ? ' (OCR)' : ''}</span></div>
        <div class="leitor-acoes"><a class="btn sm" href="${doc.arquivo}" target="_blank" rel="noopener">Abrir original</a><button type="button" class="btn sm" id="trocar">Trocar arquivo</button></div>
      </div>
      <div id="resumo"></div>
      <div class="selbar" id="selbar"></div>
      <div class="legenda">${Object.entries(CAMPOS).map(([k, c]) => `<span><i class="m-${k}"></i>${c.rot}</span>`).join('')}</div>
      <div class="paginas">${doc.paginas.map(p => `
        <div class="pg" style="aspect-ratio:${p.largura}/${p.altura}">
          <img src="${p.url}" alt="Página ${p.n}" draggable="false">
          ${doc.palavras.filter(w => w.p === p.n).map(w =>
            `<span class="wd" data-id="${w.id}" title="${esc(w.t)}" style="left:${w.x * 100}%;top:${w.y * 100}%;width:${w.w * 100}%;height:${w.h * 100}%"></span>`).join('')}
        </div>`).join('')}
      </div>
      ${ia.status === 'sem_chave' ? '<div class="alert info small">IA desligada: falta a ANTHROPIC_API_KEY no servidor. Valor e vencimento vêm da linha digitável; os outros campos você marca clicando.</div>' : ''}
      ${ia.status === 'erro' ? `<div class="alert warn small">A IA não respondeu (${esc(ia.erro)}). Marque os campos clicando no documento.</div>` : ''}`;
    leitor.querySelector('#trocar').onclick = () => vazio();
    leitor.querySelector('.paginas').addEventListener('click', e => {
      const w = e.target.closest('.wd');
      if (!w) return;
      sel.has(w.dataset.id) ? sel.delete(w.dataset.id) : sel.add(w.dataset.id);
      w.classList.toggle('sel');
      barra();
    });
    f().dataset.anexo = doc.id;
    barra();
  }

  function barra() {
    // Altura fixa: os botões ficam sempre visíveis para o documento não "pular" entre cliques.
    const bar = leitor.querySelector('#selbar');
    const ids = doc.palavras.map(w => w.id).filter(id => sel.has(id));
    const vazio = !ids.length;
    bar.innerHTML = `<span class="sel-txt ${vazio ? 'muted' : ''}">${vazio ? 'Clique nas palavras do documento e escolha o campo:' : `“${esc(texto(ids))}”`}</span>
      <span class="sel-btns">${Object.entries(CAMPOS).map(([k, c]) => `<button type="button" class="btn sm campo m-${k}" data-campo="${k}" ${vazio ? 'disabled' : ''}>${c.rot}</button>`).join('')}
      <button type="button" class="btn sm" data-limpar ${vazio ? 'disabled' : ''}>Limpar</button></span>`;
    bar.querySelectorAll('[data-campo]').forEach(b => b.onclick = () => {
      if (aplicar(b.dataset.campo, texto(ids), ids, 'você')) limparSel();
    });
    bar.querySelector('[data-limpar]').onclick = limparSel;
  }

  function limparSel() {
    sel.clear();
    leitor.querySelectorAll('.wd.sel').forEach(w => w.classList.remove('sel'));
    barra();
  }

  function marcar(campo, ids) {
    leitor.querySelectorAll(`.wd.m-${campo}`).forEach(w => w.classList.remove(`m-${campo}`));
    marcas[campo] = ids;
    ids.forEach(id => leitor.querySelector(`.wd[data-id="${id}"]`)?.classList.add(`m-${campo}`));
  }

  function preencher(campo, valor, origem) {
    let alvo;
    if (campo === 'fornecedor') {
      // Fornecedor só do cadastro: procura pelo nome lido; se não achar, o seletor oferece cadastrar.
      const picker = f().querySelector('[data-picker]');
      const achado = picker.porNome(valor);
      alvo = picker;
      if (!achado) origem = 'não cadastrado';
    } else {
      alvo = f()[CAMPOS[campo].input];
      alvo.value = valor;
      alvo.dispatchEvent(new Event('input', { bubbles: true }));
      alvo.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const label = alvo.closest('label, .campo');
    label.querySelector('.orig')?.remove();
    label.insertAdjacentHTML('beforeend', `<span class="orig m-${campo}">${esc(origem)}</span>`);
  }

  // Seleção manual (ou sugestão) → campo do formulário. Devolve false se não deu para interpretar.
  function aplicar(campo, txt, ids, origem) {
    let valor = txt.trim();
    if (campo === 'vencimento') valor = lerData(txt);
    if (campo === 'competencia') valor = lerCompetencia(txt);
    if (campo === 'valor') { const n = lerValor(txt); valor = n ? fmtMoeda(n) : null; }
    if (!valor) {
      toast(`Não reconheci ${campo === 'valor' ? 'um valor' : 'uma data'} em “${txt}”.`);
      return false;
    }
    preencher(campo, valor, origem);
    marcar(campo, ids);
    return true;
  }

  function aplicarSugestoes() {
    const s = doc.sugestao, l = doc.linha;
    const feitos = [], avisos = [];
    if (s && s.tipo && f().tipo.value !== s.tipo) {
      f().querySelector(`input[name=tipo][value=${s.tipo}]`).checked = true;
      f().querySelector(`input[name=tipo][value=${s.tipo}]`).dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (l?.valor) {
      preencher('valor', fmtMoeda(l.valor), 'linha digitável');
      marcar('valor', s?.valor.palavras.length ? s.valor.palavras : []);
      feitos.push(`Valor ${money(l.valor)} (linha digitável)`);
      if (s?.valor.numero && Math.abs(s.valor.numero - l.valor) > 0.009) avisos.push(`A IA leu ${money(s.valor.numero)} no documento, mas a linha digitável diz ${money(l.valor)}.`);
    } else if (s?.valor.numero) {
      preencher('valor', fmtMoeda(s.valor.numero), 'IA'); marcar('valor', s.valor.palavras); feitos.push('Valor (IA)');
    }
    if (l?.vencimento) {
      preencher('vencimento', l.vencimento, 'linha digitável');
      marcar('vencimento', s?.vencimento.palavras.length ? s.vencimento.palavras : []);
      feitos.push(`Vencimento ${dm(l.vencimento)} (linha digitável)`);
      if (s?.vencimento.data && s.vencimento.data !== l.vencimento) avisos.push(`A IA leu vencimento ${dm(s.vencimento.data)}, a linha digitável diz ${dm(l.vencimento)}.`);
    } else if (s?.vencimento.data) {
      preencher('vencimento', s.vencimento.data, 'IA'); marcar('vencimento', s.vencimento.palavras); feitos.push('Vencimento (IA)');
    }
    if (s) {
      const forn = s.contato_existente || s.fornecedor.texto;
      if (forn) {
        preencher('fornecedor', forn, s.contato_existente ? 'IA · contato do Nibo' : 'IA');
        marcar('fornecedor', s.fornecedor.palavras);
        const ok = f().contato_id.value;
        if (ok) feitos.push(`Fornecedor “${f().querySelector('.picker-q').value}” (cadastro)`);
        else avisos.push(`Fornecedor “${forn}” não está no cadastro: escolha um da lista ou clique em “Cadastrar”.`);
      }
      if (s.competencia.data) { preencher('competencia', s.competencia.data, 'IA'); marcar('competencia', s.competencia.palavras); feitos.push('Competência (IA)'); }
      if (s.descricao.texto) { preencher('descricao', s.descricao.texto, 'IA'); marcar('descricao', s.descricao.palavras); feitos.push('Descrição (IA)'); }
      const catSel = f().categoria_id;
      if (s.categoria_id && [...catSel.options].some(o => o.value === s.categoria_id)) {
        catSel.value = s.categoria_id;
        const lab = catSel.closest('label');
        lab.querySelector('.orig')?.remove();
        lab.insertAdjacentHTML('beforeend', '<span class="orig">IA</span>');
        feitos.push(`Categoria “${catSel.selectedOptions[0].text}” (IA)`);
      }
      if (s.observacao) avisos.push(s.observacao);
    }
    if (l && !l.valor && l.tipo === 'arrecadacao') avisos.push('Guia de arrecadação: a linha digitável não traz valor/vencimento. Confira no documento.');
    const res = leitor.querySelector('#resumo');
    res.innerHTML = (feitos.length ? `<div class="alert ok small"><b>Preenchido automaticamente — confira antes de salvar:</b><ul>${feitos.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`
      : '<div class="alert info small">Nada foi reconhecido automaticamente. Selecione as palavras no documento e escolha o campo.</div>')
      + (l ? '' : '<div class="alert warn small">Não encontrei uma linha digitável válida neste documento.</div>')
      + (avisos.length ? `<div class="alert warn small"><b>Atenção:</b><ul>${avisos.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  vazio();
  // Documento que já está na caixa de entrada (boleto ou NF em PDF/foto).
  return {
    carregarDocumento: (id, nome) => ler(nome || 'documento da caixa de entrada',
      () => fetch(`/api/inbox/${id}/leitor`, { method: 'POST', headers: { 'x-cockpit': '1' } })),
  };
}

// Substitui a página "Novo lançamento" do fin.js por uma com o leitor ao lado do formulário.
PAGES['fin/novo'] = {
  ...PAGES['fin/novo'],
  lede: 'Mande o boleto (PDF ou foto) para preencher, ou digite direto no formulário.',
  async render(v, p) {
    await finOpcoes();
    v.innerHTML = `<div class="nl-grid"><section id="leitor" class="card leitor"></section>
      <section>${formLancamento({ tipo: p.tipo === 'receber' ? 'receber' : 'pagar' }, false, [])}</section></div>`;
    ligarForm(v, { editando: false, l: {}, grupo: [] });
    const leitorBoleto = novoLeitor(v);
    if (p.doc) leitorBoleto.carregarDocumento(p.doc);
  },
};
