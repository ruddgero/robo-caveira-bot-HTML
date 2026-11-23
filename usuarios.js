// =====================================================================
// USUÁRIOS: login por pessoa (e-mail + senha), perfis e senhas seguras
// =====================================================================
const crypto = require('crypto');
const store = require('./store');
const { novoId, agora } = require('./util');

const PERFIS = ['ADMIN', 'LIDER', 'OPERADOR', 'SUNSET'];
const ROTULO_PERFIL = { ADMIN: 'Administrador', LIDER: 'Líder', OPERADOR: 'Operador', SUNSET: 'Supervisor Sunset' };
const PERM = require('./permissoes');

let usuarios = [];

// Equipe inicial (só é usada quando ainda não existe nenhum usuário)
const EQUIPE_INICIAL = [
    { nome: 'Lais Campos', email: 'lais.campos@ferroport.com.br', perfil: 'OPERADOR' },
    { nome: 'Felipe Furtado', email: 'felipe.gabriel@ferroport.com.br', perfil: 'OPERADOR' }
];

function hashSenha(senha, sal) {
    return crypto.scryptSync(String(senha), sal, 32).toString('hex');
}

function senhaProvisoria() {
    const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(crypto.randomBytes(10)).map(b => letras[b % letras.length]).join('');
}

function normalizarEmail(e) { return String(e || '').trim().toLowerCase(); }
function emailValido(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function publico(u) {
    if (!u) return null;
    const { senhaHash, sal, ...resto } = u;
    return { ...resto, temSenha: !!senhaHash, rotuloPerfil: ROTULO_PERFIL[u.perfil] || u.perfil, permissoes: PERM.efetivas(u), excecoes: u.permissoes || {} };
}

async function salvar() { await store.set('usuarios', usuarios); }

function erro(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

async function carregar() {
    await PERM.carregar();
    usuarios = await store.get('usuarios', []) || [];
    if (!usuarios.length) {
        const senha = process.env.APP_SENHA;
        if (!senha || senha.length < 8) {
            throw new Error('Primeiro acesso: defina APP_SENHA (mínimo 8 caracteres). Ela vira a senha do administrador.');
        }
        const sal = crypto.randomBytes(16).toString('hex');
        usuarios.push({
            id: novoId(),
            nome: process.env.ADMIN_NOME || 'Ruddgero Ribeiro',
            email: normalizarEmail(process.env.ADMIN_EMAIL || 'ruddgero.ribeiro@ferroport.com.br'),
            telefone: (process.env.WHATSAPP_NUMERO_ALERTA || '').replace(/\D/g, ''),
            perfil: 'ADMIN', ativo: true, trocarSenha: false, versaoSenha: 1,
            sal, senhaHash: hashSenha(senha, sal),
            // usa a sessão de WhatsApp da versão anterior, se existir
            whatsapp: { sessao: 'whatsapp_sessao', grupos: [], pareado: false },
            criadoEm: agora().iso
        });
        for (const p of EQUIPE_INICIAL) {
            usuarios.push({
                id: novoId(), nome: p.nome, email: p.email, telefone: '', perfil: p.perfil, ativo: true,
                trocarSenha: true, versaoSenha: 1, sal: null, senhaHash: null,
                whatsapp: { sessao: null, grupos: [], pareado: false }, criadoEm: agora().iso
            });
        }
        await salvar();
        console.log(`👤 [USUÁRIOS] Administrador criado: ${usuarios[0].email} (senha = APP_SENHA).`);
    }
    // garante campos novos
    for (const u of usuarios) {
        u.whatsapp = u.whatsapp || { grupos: [], pareado: false };
        if (!u.whatsapp.sessao) u.whatsapp.sessao = `whatsapp_sessao_${u.id}`;
        u.whatsapp.grupos = u.whatsapp.grupos || [];
    }
}

function porId(id) { return usuarios.find(u => u.id === id) || null; }
function porEmail(email) { return usuarios.find(u => u.email === normalizarEmail(email)) || null; }
function todos() { return usuarios; }
function admin() { return usuarios.find(u => u.perfil === 'ADMIN' && u.ativo) || null; }

function autenticar(email, senha) {
    const u = porEmail(email);
    if (!u || !u.ativo || !u.senhaHash) return null;
    const a = Buffer.from(hashSenha(senha, u.sal), 'hex');
    const b = Buffer.from(u.senhaHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}

async function definirSenha(u, nova, { provisoria = false } = {}) {
    if (!nova || String(nova).length < 8) throw erro('A senha precisa ter pelo menos 8 caracteres.');
    u.sal = crypto.randomBytes(16).toString('hex');
    u.senhaHash = hashSenha(nova, u.sal);
    u.trocarSenha = provisoria;
    u.versaoSenha = (u.versaoSenha || 1) + 1;
    await salvar();
}

async function criar({ nome, email, telefone, perfil }) {
    const e = normalizarEmail(email);
    if (!String(nome || '').trim()) throw erro('Informe o nome.');
    if (!emailValido(e)) throw erro('Informe um e-mail válido (obrigatório).');
    if (porEmail(e)) throw erro('Já existe um usuário com esse e-mail.');
    if (!PERFIS.includes(perfil)) throw erro('Perfil inválido.');
    const u = {
        id: novoId(), nome: nome.trim(), email: e, telefone: String(telefone || '').replace(/\D/g, ''),
        perfil, ativo: true, trocarSenha: true, versaoSenha: 1, sal: null, senhaHash: null,
        whatsapp: { sessao: null, grupos: [], pareado: false }, criadoEm: agora().iso
    };
    u.whatsapp.sessao = `whatsapp_sessao_${u.id}`;
    usuarios.push(u);
    const senha = senhaProvisoria();
    await definirSenha(u, senha, { provisoria: true });
    return { usuario: u, senhaProvisoria: senha };
}

async function atualizar(id, dados, { porAdmin = false } = {}) {
    const u = porId(id);
    if (!u) throw erro('Usuário não encontrado.', 404);
    if (dados.nome !== undefined) { if (!dados.nome.trim()) throw erro('Informe o nome.'); u.nome = dados.nome.trim(); }
    if (dados.telefone !== undefined) u.telefone = String(dados.telefone).replace(/\D/g, '');
    if (porAdmin) {
        if (dados.email !== undefined) {
            const e = normalizarEmail(dados.email);
            if (!emailValido(e)) throw erro('E-mail inválido.');
            const outro = porEmail(e);
            if (outro && outro.id !== u.id) throw erro('Já existe um usuário com esse e-mail.');
            u.email = e;
        }
        if (dados.perfil !== undefined) {
            if (!PERFIS.includes(dados.perfil)) throw erro('Perfil inválido.');
            if (u.perfil === 'ADMIN' && dados.perfil !== 'ADMIN' && usuarios.filter(x => x.perfil === 'ADMIN' && x.ativo).length < 2) throw erro('É preciso ter pelo menos um administrador.');
            u.perfil = dados.perfil;
        }
        if (dados.excecoes !== undefined) u.permissoes = PERM.limparExcecoes(dados.excecoes);
        if (dados.ativo !== undefined) {
            if (!dados.ativo && u.perfil === 'ADMIN' && usuarios.filter(x => x.perfil === 'ADMIN' && x.ativo).length < 2) throw erro('Não dá para desativar o único administrador.');
            u.ativo = !!dados.ativo;
            if (!u.ativo) u.versaoSenha = (u.versaoSenha || 1) + 1; // derruba sessões abertas
        }
    }
    await salvar();
    return u;
}

async function redefinirSenha(id) {
    const u = porId(id);
    if (!u) throw erro('Usuário não encontrado.', 404);
    const senha = senhaProvisoria();
    await definirSenha(u, senha, { provisoria: true });
    return senha;
}

async function trocarSenha(id, atual, nova) {
    const u = porId(id);
    if (!u) throw erro('Usuário não encontrado.', 404);
    if (!u.trocarSenha && !autenticar(u.email, atual)) throw erro('Senha atual incorreta.', 401);
    if (u.trocarSenha && u.senhaHash && !autenticar(u.email, atual)) throw erro('Senha provisória incorreta.', 401);
    await definirSenha(u, nova);
    return u;
}

async function atualizarWhatsapp(id, parcial) {
    const u = porId(id);
    if (!u) return null;
    Object.assign(u.whatsapp, parcial);
    await salvar();
    return u;
}

const podeLiderar = u => PERM.pode(u, 'plantao.liderar');

module.exports = {
    PERFIS, ROTULO_PERFIL, carregar, porId, porEmail, todos, admin, autenticar, criar, atualizar,
    redefinirSenha, trocarSenha, atualizarWhatsapp, publico, podeLiderar
};
