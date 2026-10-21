// Sessão e perfis na tela. A proteção de verdade é no servidor (auth.permitido); aqui só
// escondemos o que o perfil não usa e mostramos login / configuração inicial / primeiro acesso.

let USUARIO = null;
const ROTAS_PERFIL = {
  funcionario: ['portal', 'afazeres', 'checklist', 'producao'],
  responsavel_caixa: ['portal', 'caixa', 'afazeres', 'checklist', 'producao'],
};
const rotaInicial = () => (!USUARIO || USUARIO.perfil === 'admin' ? 'painel' : 'portal');
const rotaPermitida = r => !USUARIO || USUARIO.perfil === 'admin' || (ROTAS_PERFIL[USUARIO.perfil] || []).includes(r)
  || (r === 'estoque' && (USUARIO.estoque_setores || []).length > 0);   // habilitação de estoque vale em qualquer perfil
const ehAdmin = () => USUARIO?.perfil === 'admin';
const ROT_PERFIL = { admin: 'Administrador', responsavel_caixa: 'Responsável de caixa', funcionario: 'Funcionário' };

const fmtCpf = v => {
  const d = String(v || '').replace(/\D/g, '').slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
};
document.addEventListener('input', e => {
  if (e.target.matches?.('input.cpf')) { const f = fmtCpf(e.target.value); if (f !== e.target.value) e.target.value = f; }
}, true);

function telaAuth(html, ligar) {
  document.body.classList.add('sem-sessao');
  const t = document.getElementById('auth-tela');
  t.hidden = false;
  t.innerHTML = `<div class="auth-card">
      <div class="brand auth-brand">${marcaHtml('Cockpit')}</div>
      ${html}
    </div>`;
  const f = t.querySelector('form');
  const err = t.querySelector('.auth-err');
  t.querySelectorAll('[data-ver]').forEach(b => b.onclick = () => {
    const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? 'mostrar' : 'ocultar';
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const btn = f.querySelector('button.primary'); btn.disabled = true;
    try { await ligar(f); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; }
  });
  f.querySelector('input')?.focus();
}
const campoSenha = (nome, rot, auto = 'current-password') => `<label>${rot}<span class="senha-l">
  <input type="password" name="${nome}" autocomplete="${auto}" required minlength="${auto === 'new-password' ? 8 : 1}" maxlength="200">
  <button type="button" class="link-mini" data-ver>mostrar</button></span></label>`;

function telaLogin(msg = '') {
  telaAuth(`<h2>Entrar</h2>
    ${msg ? `<div class="alert info small">${esc(msg)}</div>` : ''}
    <form class="auth-form" autocomplete="on">
      <label>CPF<input class="cpf" name="cpf" inputmode="numeric" autocomplete="username" placeholder="000.000.000-00" required></label>
      ${campoSenha('senha', 'Senha')}
      <div class="auth-err alert" hidden></div>
      <button class="btn primary">Entrar</button>
    </form>
    <p class="muted small-txt">Esqueceu a senha ou é seu primeiro acesso? Peça o link ao administrador.</p>`,
  async f => {
    await send('POST', 'auth/login', { cpf: f.cpf.value, senha: f.senha.value });
    location.hash = ''; location.reload();
  });
}

function telaConfigurar() {
  telaAuth(`<h2>Configuração inicial</h2>
    <p class="muted small-txt">Crie a conta do administrador (você). Esta tela só aparece uma vez: depois de criada, todo acesso passa a exigir CPF e senha.</p>
    <form class="auth-form">
      <label>Seu nome<input name="nome" required maxlength="120" autocomplete="name"></label>
      <label>CPF<input class="cpf" name="cpf" inputmode="numeric" autocomplete="username" placeholder="000.000.000-00" required></label>
      ${campoSenha('senha', 'Senha (8+ caracteres, letras e números)', 'new-password')}
      ${campoSenha('senha2', 'Repita a senha', 'new-password')}
      <div class="auth-err alert" hidden></div>
      <button class="btn primary">Criar conta de administrador</button>
    </form>`,
  async f => {
    if (f.senha.value !== f.senha2.value) throw new Error('As senhas não conferem');
    await send('POST', 'auth/configurar', { nome: f.nome.value, cpf: f.cpf.value, senha: f.senha.value });
    location.hash = ''; location.reload();
  });
}

async function telaPrimeiroAcesso(token) {
  let nome = '';
  try { nome = (await api(`auth/convite?t=${encodeURIComponent(token)}`)).nome; }
  catch (e) { return telaLogin(e.message); }
  telaAuth(`<h2>Olá, ${esc(nome)}!</h2>
    <p class="muted small-txt">Crie sua senha para acessar o portal: pelo menos 8 caracteres, com letras e números, sem usar seu CPF.</p>
    <form class="auth-form">
      ${campoSenha('senha', 'Nova senha', 'new-password')}
      ${campoSenha('senha2', 'Repita a senha', 'new-password')}
      <div class="auth-err alert" hidden></div>
      <button class="btn primary">Criar senha e entrar</button>
    </form>`,
  async f => {
    if (f.senha.value !== f.senha2.value) throw new Error('As senhas não conferem');
    await send('POST', 'auth/definir-senha', { token, senha: f.senha.value });
    location.hash = '#/portal'; location.reload();
  });
}

function sessaoExpirada() {
  if (document.body.classList.contains('sem-sessao')) return;
  USUARIO = null;
  telaLogin('Sua sessão terminou. Entre de novo.');
}

function montarMenu() {
  document.querySelectorAll('nav a[data-route]').forEach(a => {
    const perfis = (a.dataset.perfis || 'admin').split(',');
    const temEstoque = perfis.includes('estoque') && (USUARIO.estoque_setores || []).length > 0;
    a.hidden = !(perfis.includes(USUARIO.perfil) || temEstoque) || (a.dataset.route === 'portal' && !USUARIO.pessoa_id && USUARIO.perfil === 'admin');
  });
  document.querySelectorAll('nav .nav-sep').forEach(s => { s.hidden = !ehAdmin(); });
  document.getElementById('etl').hidden = !ehAdmin();
  const box = document.getElementById('usuario-box');
  box.innerHTML = `<div class="u-nome">${esc(USUARIO.nome)}</div><div class="u-perfil">${ROT_PERFIL[USUARIO.perfil]}</div>
    <button class="link-mini" id="sair">Sair</button>`;
  box.querySelector('#sair').onclick = async () => { await send('POST', 'auth/logout').catch(() => {}); location.hash = ''; location.reload(); };
}

async function iniciarSessao() {
  await carregarEmpresa();   // nome e logo do restaurante (também na tela de login)
  const h = location.hash;
  if (h.startsWith('#/primeiro-acesso')) {
    return telaPrimeiroAcesso(new URLSearchParams(h.split('?')[1] || '').get('t') || '');
  }
  const r = await fetch('/api/auth/eu');
  if (r.status === 401) {
    const e = await api('auth/estado');
    return e.configurado ? telaLogin() : telaConfigurar();
  }
  USUARIO = await r.json();
  document.body.classList.remove('sem-sessao');
  document.getElementById('auth-tela').hidden = true;
  aplicarMarca();            // com o ✎ de edição para o admin
  montarMenu();
  renderPeriodo();
  render();
  if (ehAdmin()) { renderEtl(); atualizarBadgeInbox(); }
  atualizarBadgeAfazeres();
  setInterval(atualizarBadgeAfazeres, 120000);   // o selo acompanha o que a equipe vai fechando
}
