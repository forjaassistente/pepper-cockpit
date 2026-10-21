// Cadastro do restaurante: nome e logo na barra lateral, no login e no título; o admin edita pelo ✎ ao lado do nome.
// Servidor: empresa.py (nome e logo são públicos porque aparecem na tela de login).

let EMPRESA = { nome_fantasia: '', tem_logo: false };
const nomeEmpresa = () => EMPRESA.nome_fantasia || 'Cockpit';
const iniciais = n => (String(n || '').match(/[A-Za-zÀ-ú0-9]+/g) || ['?']).filter(p => p.length > 2 || /\d/.test(p)).slice(0, 2)
  .map(p => p[0].toUpperCase()).join('') || String(n || '?')[0].toUpperCase();
const fmtCnpj = v => String(v || '').replace(/\D/g, '').slice(0, 14).replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
  .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
const fmtCep = v => String(v || '').replace(/\D/g, '').slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2');

async function carregarEmpresa() {
  try { EMPRESA = await (await fetch('/api/empresa/publico')).json(); } catch { /* sem rede: segue com o padrão */ }
  aplicarMarca();
}

// logo (ou iniciais) + nome; usado na barra lateral e na tela de login
function marcaHtml(sub, editavel = false) {
  const logo = EMPRESA.tem_logo
    ? `<div class="logo tem-img"><img src="/api/empresa/publico/logo?v=${encodeURIComponent(EMPRESA.atualizado_em || '')}" alt=""></div>`
    : `<div class="logo">${esc(iniciais(nomeEmpresa()))}</div>`;
  return `${logo}<div class="brand-txt"><div class="brand-name">${esc(nomeEmpresa())}</div><div class="brand-sub">${sub}</div></div>
    ${editavel ? '<button type="button" class="brand-edit" id="brand-edit" title="Editar dados do restaurante" aria-label="Editar dados do restaurante">✎</button>' : ''}`;
}

function aplicarMarca() {
  const b = document.getElementById('brand');
  if (b) {
    b.innerHTML = marcaHtml('Cockpit diário', USUARIO?.perfil === 'admin');
    b.querySelector('#brand-edit')?.addEventListener('click', dialogoEmpresa);
  }
  if (!document.title.includes('·')) document.title = `Cockpit ${nomeEmpresa()}`;
}

async function dialogoEmpresa() {
  const e = await api('empresa');
  let dr = document.getElementById('drawer');
  if (!dr) { dr = document.createElement('dialog'); dr.id = 'drawer'; document.body.appendChild(dr); }
  dr.className = 'drawer';
  const campo = (k, rot, extra = '') => `<label${extra.includes('span2') ? ' class="span2"' : ''}>${rot}<input name="${k}" value="${esc(e[k] ?? '')}" ${extra.replace('span2', '')}></label>`;
  dr.innerHTML = `<form class="drawer-body" autocomplete="off" novalidate>
    <div class="drawer-head"><div><div class="eyebrow">Cadastro</div><h3>Dados do restaurante</h3></div>
      <button type="button" class="btn sm" data-fechar aria-label="Fechar">✕</button></div>
    <div class="drawer-campos">
      <div class="span2 emp-logo">
        <div class="logo grande ${e.logo ? 'tem-img' : ''}" id="emp-prev">${e.logo ? `<img src="/api/empresa/publico/logo?v=${Date.now()}" alt="">` : esc(iniciais(e.nome_fantasia))}</div>
        <div><b>Logo</b><small>PNG, JPG ou WebP. Aparece no canto da tela e no login.</small>
          <div class="actions" style="justify-content:flex-start"><label class="btn sm">Escolher imagem<input type="file" id="emp-logo" accept="image/png,image/jpeg,image/webp" hidden></label>
          ${e.logo ? '<button type="button" class="btn sm" id="emp-ajustar">Ajustar logo atual</button><button type="button" class="btn sm perigo" id="emp-tira">Remover</button>' : ''}</div></div>
      </div>
      <h4 class="span2 emp-sec">Identificação</h4>
      ${campo('nome_fantasia', 'Nome do restaurante * <small>aparece no app e nas mensagens</small>', 'required maxlength="80" span2')}
      ${campo('razao_social', 'Razão social', 'maxlength="150" span2')}
      <label>CNPJ<input name="cnpj" class="cnpj" inputmode="numeric" value="${esc(fmtCnpj(e.cnpj))}" placeholder="00.000.000/0000-00"></label>
      ${campo('inscricao_estadual', 'Inscrição estadual', 'maxlength="20"')}
      <label class="span2">Segmento<select name="segmento"><option value="">—</option>${e.segmentos.map(s => `<option ${s === e.segmento ? 'selected' : ''}>${s}</option>`).join('')}
        ${e.segmento && !e.segmentos.includes(e.segmento) ? `<option selected>${esc(e.segmento)}</option>` : ''}</select></label>
      <h4 class="span2 emp-sec">Contato</h4>
      <label>Telefone<input name="telefone" class="phone" type="tel" inputmode="tel" maxlength="15" value="${esc(fmtTelefone(e.telefone))}" placeholder="(00) 00000-0000"></label>
      <label>WhatsApp<input name="whatsapp" class="phone" type="tel" inputmode="tel" maxlength="15" value="${esc(fmtTelefone(e.whatsapp))}" placeholder="(00) 00000-0000"></label>
      ${campo('email', 'E-mail', 'type="email" maxlength="120"')}
      ${campo('instagram', 'Instagram', 'maxlength="60" placeholder="@seurestaurante"')}
      ${campo('site', 'Site', 'maxlength="120" placeholder="www.seurestaurante.com.br" span2')}
      <h4 class="span2 emp-sec">Endereço</h4>
      <label>CEP<input name="cep" class="cep" inputmode="numeric" value="${esc(fmtCep(e.cep))}" placeholder="00000-000"></label>
      ${campo('numero', 'Número', 'maxlength="20"')}
      ${campo('logradouro', 'Rua / avenida', 'maxlength="120" span2')}
      ${campo('complemento', 'Complemento', 'maxlength="60"')}
      ${campo('bairro', 'Bairro', 'maxlength="60"')}
      ${campo('cidade', 'Cidade', 'maxlength="60"')}
      ${campo('uf', 'UF', 'maxlength="2" placeholder="SC" style="text-transform:uppercase"')}
    </div>
    <div class="dlg-err" hidden></div>
    <div class="drawer-foot"><span class="muted small-txt">Só o administrador vê e edita estes dados.</span>
      <div class="actions"><button type="button" class="btn" data-fechar>Cancelar</button><button type="submit" class="btn primary">Salvar</button></div></div>
  </form>`;
  const f = dr.querySelector('form'), err = dr.querySelector('.dlg-err');
  const erro = m => { err.hidden = false; err.textContent = m; };
  dr.querySelectorAll('[data-fechar]').forEach(b => b.onclick = () => dr.close());
  f.addEventListener('input', ev => {   // máscaras de CNPJ e CEP
    if (ev.target.matches('.cnpj')) ev.target.value = fmtCnpj(ev.target.value);
    if (ev.target.matches('.cep')) ev.target.value = fmtCep(ev.target.value);
  });
  const recarregarMarca = async () => { await carregarEmpresa(); };
  // recorta no editor e envia o recorte + a imagem original (para reajustar depois sem perder qualidade)
  const ajustarEEnviar = async original => {
    err.hidden = true;
    let recorte;
    try { recorte = await recortarLogo(original, f.elements.nome_fantasia.value || nomeEmpresa()); } catch (ex) { return erro(ex.message); }
    if (!recorte) return;                       // cancelou o recorte
    const fd = new FormData(); fd.append('arquivo', recorte, 'logo.png'); fd.append('original', original, 'original.png');
    const r = await fetch('/api/empresa/logo', { method: 'POST', headers: { 'x-cockpit': '1' }, body: fd });
    if (!r.ok) return erro(erroDe(await r.json().catch(() => ({})), r.status));
    await recarregarMarca();
    dialogoEmpresa();   // redesenha com o logo novo (mantém o painel aberto)
  };
  dr.querySelector('#emp-logo').onchange = ev => {
    const arq = ev.target.files[0];
    ev.target.value = '';
    if (arq) ajustarEEnviar(arq);
  };
  dr.querySelector('#emp-ajustar')?.addEventListener('click', async () => {
    const r = await fetch('/api/empresa/logo/original', { cache: 'no-store' });
    if (!r.ok) return erro('Não encontrei a imagem do logo. Escolha o arquivo de novo.');
    ajustarEEnviar(await r.blob());
  });
  dr.querySelector('#emp-tira')?.addEventListener('click', async () => {
    if (!confirm('Remover o logo? Volta a aparecer as iniciais do nome.')) return;
    try { await send('DELETE', 'empresa/logo'); await recarregarMarca(); dialogoEmpresa(); } catch (ex) { erro(ex.message); }
  });
  f.onsubmit = async ev => {
    ev.preventDefault(); err.hidden = true;
    const d = Object.fromEntries([...new FormData(f)].filter(([k]) => k !== 'arquivo'));
    if (!d.nome_fantasia?.trim()) return erro('Informe o nome do restaurante.');
    try {
      await send('PUT', 'empresa', d);
      dr.close();
      await recarregarMarca();
      document.title = `${document.getElementById('title').textContent} · Cockpit ${nomeEmpresa()}`;
      FLASH = 'Dados do restaurante salvos.'; render();
    } catch (ex) { erro(ex.message); }
  };
  if (!dr.open) dr.showModal();
}

// ---------------------------------------------------------------- recorte do logo
// Prévia redonda grande + prévia de como fica na barra lateral. Arrasta para posicionar, zoom pela barra ou rodinha,
// fundo automático (cor da borda da imagem), branco, preto ou transparente. Gera PNG de 512 px recortado no círculo.
function corDaBorda(img) {
  // média dos pixels da borda que não são transparentes: o fundo do próprio logo (ex.: preto)
  const cv = document.createElement('canvas'), n = 64;
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  let r = 0, gr = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) for (const [x, y] of [[i, 0], [i, n - 1], [0, i], [n - 1, i]]) {
    const k = (y * n + x) * 4;
    if (d[k + 3] > 200) { r += d[k]; gr += d[k + 1]; b += d[k + 2]; c++; }
  }
  if (c < n) return null;                         // borda transparente: não há cor de fundo para seguir
  const h = v => Math.round(v / c).toString(16).padStart(2, '0');
  return `#${h(r)}${h(gr)}${h(b)}`;
}

function recortarLogo(arquivo, nome) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não deu para abrir esta imagem. Use PNG, JPG ou WebP.')); };
    img.onload = () => {
      const S = 280, w = img.naturalWidth, h = img.naturalHeight;
      const sCaber = S / Math.hypot(w, h);            // logo inteiro dentro do círculo
      const sPreencher = Math.max(S / w, S / h);      // círculo todo coberto
      const sMin = sCaber * 0.5, sMax = sPreencher * 4;
      const auto = corDaBorda(img);
      let fundo = auto || '#ffffff';
      // com fundo de cor (ex.: logo preto), começa ocupando a largura do círculo; sem fundo, o logo inteiro dentro
      let s = auto ? Math.min(sPreencher, S * 0.92 / w) : sCaber, x = (S - w * s) / 2, y = (S - h * s) / 2;
      let dlg = document.getElementById('dlg-recorte');
      if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dlg-recorte'; dlg.className = 'dlg recorte'; document.body.appendChild(dlg); }
      const opFundo = [...(auto ? [[auto, 'automático']] : []), ['#ffffff', 'branco'], ['#000000', 'preto'], ['transparente', 'transparente']];
      dlg.innerHTML = `<div class="dlg-body">
        <h3>Ajustar o logo</h3>
        <p class="sub">Arraste para posicionar e use o zoom. O que fica dentro do círculo é o que aparece no app.</p>
        <div class="rc-area">
          <div class="rc-palco" id="rc-palco"><img src="${url}" alt="" draggable="false"><div class="rc-mascara"></div></div>
          <div class="rc-prev"><small>Como fica na barra lateral</small>
            <div class="rc-prev-barra"><canvas id="rc-mini" width="76" height="76"></canvas>
              <div><b>${esc(nome || '')}</b><span>Cockpit diário</span></div></div></div>
        </div>
        <label class="rc-zoom">Zoom<input type="range" id="rc-zoom" min="0" max="1000" step="1"></label>
        <div class="rc-botoes">
          <button type="button" class="btn sm" data-modo="caber">Caber inteira</button>
          <button type="button" class="btn sm" data-modo="largura">Ocupar a largura</button>
          <button type="button" class="btn sm" data-modo="preencher">Preencher o círculo</button>
        </div>
        <div class="rc-fundo"><span>Fundo do círculo:</span>${opFundo.map(([v, rot], i) =>
          `<label><input type="radio" name="rc-fundo" value="${v}" ${i === 0 ? 'checked' : ''}>
            <i class="rc-cor" style="${v === 'transparente' ? '' : `background:${v}`}"></i>${rot}</label>`).join('')}</div>
        <div class="actions"><button type="button" class="btn" data-cancelar>Cancelar</button><button type="button" class="btn primary" data-usar>Usar este recorte</button></div>
      </div>`;
      const palco = dlg.querySelector('#rc-palco'), foto = palco.querySelector('img'), zoom = dlg.querySelector('#rc-zoom');
      const mini = dlg.querySelector('#rc-mini');
      const paraBarra = v => Math.round(Math.log(v / sMin) / Math.log(sMax / sMin) * 1000);
      const daBarra = b => sMin * Math.pow(sMax / sMin, b / 1000);
      // desenha o círculo num canvas de lado N (usado na miniatura e no arquivo final)
      const pintar = (cv, N) => {
        const g = cv.getContext('2d'), k = N / S;
        g.clearRect(0, 0, N, N); g.save();
        g.beginPath(); g.arc(N / 2, N / 2, N / 2, 0, Math.PI * 2); g.clip();
        if (fundo !== 'transparente') { g.fillStyle = fundo; g.fillRect(0, 0, N, N); }
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, x * k, y * k, w * s * k, h * s * k);
        g.restore();
      };
      const desenhar = () => {
        foto.style.width = `${w * s}px`; foto.style.height = `${h * s}px`;
        foto.style.transform = `translate(${x}px, ${y}px)`;
        palco.style.background = fundo === 'transparente' ? '' : fundo;
        palco.classList.toggle('fundo-xadrez', fundo === 'transparente');
        zoom.value = paraBarra(s);
        pintar(mini, 76);
      };
      const zoomPara = (novo, cx = S / 2, cy = S / 2) => {   // mantém fixo o ponto sob o cursor (ou o centro)
        novo = Math.min(sMax, Math.max(sMin, novo));
        x = cx - (cx - x) * (novo / s); y = cy - (cy - y) * (novo / s); s = novo; desenhar();
      };
      const centralizar = () => { x = (S - w * s) / 2; y = (S - h * s) / 2; desenhar(); };
      zoom.oninput = () => zoomPara(daBarra(Number(zoom.value)));
      palco.addEventListener('wheel', e => {
        e.preventDefault();
        const r = palco.getBoundingClientRect();
        zoomPara(s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      let arrasto = null;
      palco.addEventListener('pointerdown', e => { arrasto = { px: e.clientX, py: e.clientY, x, y }; palco.setPointerCapture(e.pointerId); palco.classList.add('arrastando'); });
      palco.addEventListener('pointermove', e => {
        if (!arrasto) return;
        x = arrasto.x + e.clientX - arrasto.px; y = arrasto.y + e.clientY - arrasto.py; desenhar();
      });
      const soltar = () => { arrasto = null; palco.classList.remove('arrastando'); };
      palco.addEventListener('pointerup', soltar); palco.addEventListener('pointercancel', soltar);
      dlg.querySelectorAll('[data-modo]').forEach(b => b.onclick = () => {
        s = { caber: sCaber, largura: S * 0.92 / w, preencher: sPreencher }[b.dataset.modo]; centralizar();
      });
      dlg.querySelectorAll('[name=rc-fundo]').forEach(r => r.onchange = () => { fundo = r.value; desenhar(); });
      const fechar = res => { dlg.close(); URL.revokeObjectURL(url); resolve(res); };
      dlg.querySelector('[data-cancelar]').onclick = () => fechar(null);
      dlg.oncancel = e => { e.preventDefault(); fechar(null); };
      dlg.querySelector('[data-usar]').onclick = () => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 512;
        pintar(cv, 512);
        cv.toBlob(b => fechar(b), 'image/png');
      };
      desenhar();
      dlg.showModal();
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------- impressão (folha de contagem, ficha de produção)
// Abre uma janela só com o documento, já no formato de papel A4, e chama a impressão.
function imprimirDoc(titulo, corpo) {
  const w = window.open('', '_blank');
  if (!w) { alert('O navegador bloqueou a janela de impressão. Libere pop-ups para este site e tente de novo.'); return; }
  const logo = EMPRESA.tem_logo ? `<img class="p-logo" src="${location.origin}/api/empresa/publico/logo" alt="">` : '';
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { font: 11.5pt/1.35 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; margin: 0; }
    .p-cab { display: flex; align-items: center; gap: 12px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
    .p-logo { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; }
    .p-cab h1 { font-size: 15pt; margin: 0; } .p-cab small { color: #555; display: block; }
    .p-campos { display: flex; gap: 24px; margin: 6px 0 12px; font-size: 10.5pt; }
    .p-campos span { flex: 1; border-bottom: 1px solid #999; padding-bottom: 2px; }
    h2 { font-size: 12.5pt; margin: 14px 0 4px; padding: 4px 8px; background: #eee; border-radius: 4px; }
    h3 { font-size: 10.5pt; margin: 10px 0 2px; text-transform: uppercase; letter-spacing: .04em; color: #444; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #bbb; padding: 5px 6px; text-align: left; vertical-align: top; }
    th { font-size: 9pt; text-transform: uppercase; color: #555; border-bottom: 1.5px solid #111; }
    .n { text-align: right; white-space: nowrap; } .caixa { width: 32mm; border: 1px solid #777; } .obs { width: 38mm; }
    .quebra { page-break-before: always; } tr { page-break-inside: avoid; }
    .p-foto { float: right; width: 70mm; max-height: 70mm; object-fit: cover; border-radius: 6px; margin: 0 0 8px 12px; }
    .p-preparo { white-space: pre-wrap; border: 1px solid #bbb; border-radius: 4px; padding: 8px 10px; }
    .p-rod { margin-top: 14px; font-size: 9pt; color: #666; }
    @media screen { body { max-width: 190mm; margin: 16px auto; } }
  </style></head><body>${corpo.replace(/__LOGO__/g, logo)}</body></html>`);
  w.document.close();
  let foi = false;   // imprime uma vez só: quando as imagens (logo, foto) terminam de carregar, ou no máximo em 3 s
  const imprimir = () => { if (foi) return; foi = true; try { w.focus(); w.print(); } catch (_) { /* janela fechada */ } };
  const imgs = [...w.document.images].map(im => (im.complete ? null : new Promise(r => { im.onload = im.onerror = r; })));
  Promise.all(imgs).then(() => setTimeout(imprimir, 150));
  setTimeout(imprimir, 4000);
}
