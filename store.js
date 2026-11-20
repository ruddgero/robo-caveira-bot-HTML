// Persistência: usa Firebase Firestore se FIREBASE_CREDENTIALS estiver no .env;
// caso contrário grava arquivos JSON na pasta ./dados (ideal para rodar num PC).
const fs = require('fs');
const path = require('path');

const PASTA_DADOS = process.env.CAVEIRA_DADOS || path.join(__dirname, 'dados');   // CAVEIRA_DADOS: pasta separada (teste)
let db = null;
let modo = 'disco';

function iniciar() {
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            const admin = require('firebase-admin');
            const cred = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred) });
            db = admin.firestore();
            modo = 'firestore';
        } catch (e) {
            console.error('⚠️  [DADOS] Não foi possível usar o Firebase (' + e.message + '). Usando a pasta ./dados.');
        }
    }
    if (modo === 'disco' && !fs.existsSync(PASTA_DADOS)) fs.mkdirSync(PASTA_DADOS, { recursive: true });
    console.log(`💾 [DADOS] Armazenamento: ${modo === 'firestore' ? 'Firebase Firestore' : 'pasta ./dados'}`);
}

function arquivo(chave) {
    return path.join(PASTA_DADOS, chave.replace(/[^a-z0-9_\-]/gi, '_') + '.json');
}

async function get(chave, padrao = null) {
    try {
        if (db) {
            const doc = await db.collection('caveira').doc(chave).get();
            return doc.exists ? JSON.parse(doc.data().json) : padrao;
        }
        const f = arquivo(chave);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : padrao;
    } catch (e) {
        console.error(`⚠️  [DADOS] Erro ao ler "${chave}":`, e.message);
        return padrao;
    }
}

async function set(chave, valor) {
    if (db) {
        await db.collection('caveira').doc(chave).set({ json: JSON.stringify(valor), atualizadoEm: new Date().toISOString() });
        return;
    }
    const f = arquivo(chave);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(valor, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
}

// Histórico de turnos fechados (um registro por turno)
async function arquivarTurno(ficha) {
    const id = `${(ficha.data || '').split('/').reverse().join('-')}_${ficha.turno || 'TURNO'}_${Date.now()}`;
    if (db) {
        await db.collection('caveira_historico').doc(id).set({ json: JSON.stringify(ficha), criadoEm: new Date().toISOString() });
        return id;
    }
    const pasta = path.join(PASTA_DADOS, 'historico');
    if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, id + '.json'), JSON.stringify(ficha, null, 2), 'utf-8');
    return id;
}

async function listarHistorico(limite = 30) {
    if (db) {
        const snap = await db.collection('caveira_historico').orderBy('criadoEm', 'desc').limit(limite).get();
        return snap.docs.map(d => ({ id: d.id, ficha: JSON.parse(d.data().json) }));
    }
    const pasta = path.join(PASTA_DADOS, 'historico');
    if (!fs.existsSync(pasta)) return [];
    return fs.readdirSync(pasta).filter(n => n.endsWith('.json'))
        .map(n => ({ n, t: fs.statSync(path.join(pasta, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t).slice(0, limite)
        .map(({ n }) => ({ id: n.replace('.json', ''), ficha: JSON.parse(fs.readFileSync(path.join(pasta, n), 'utf-8')) }));
}

// Histórico completo de relatórios (um documento por relatório, sem limite)
const COLECAO_REL = 'caveira_relatorios';
async function salvarRelatorio(rel) {
    if (db) {
        await db.collection(COLECAO_REL).doc(rel.id).set({ json: JSON.stringify(rel), chave: rel.chave || '', criadoEm: rel.capturadoEm || new Date().toISOString() });
        return;
    }
    const pasta = path.join(PASTA_DADOS, 'relatorios');
    if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, rel.id.replace(/[^a-z0-9_\-]/gi, '_') + '.json'), JSON.stringify(rel), 'utf-8');
}

async function listarRelatorios() {
    try {
        if (db) {
            const snap = await db.collection(COLECAO_REL).get();
            return snap.docs.map(d => JSON.parse(d.data().json));
        }
        const pasta = path.join(PASTA_DADOS, 'relatorios');
        if (!fs.existsSync(pasta)) return [];
        return fs.readdirSync(pasta).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(pasta, n), 'utf-8')));
    } catch (e) {
        console.error('⚠️  [DADOS] Erro ao listar relatórios:', e.message);
        return [];
    }
}

async function excluirRelatorio(id) {
    if (db) return db.collection(COLECAO_REL).doc(id).delete();
    const f = path.join(PASTA_DADOS, 'relatorios', id.replace(/[^a-z0-9_\-]/gi, '_') + '.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

module.exports = {
    iniciar, get, set, arquivarTurno, listarHistorico, salvarRelatorio, listarRelatorios, excluirRelatorio,
    get db() { return db; },
    get modo() { return modo; },
    PASTA_DADOS
};
