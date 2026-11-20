// Utilitários: data/hora sempre no fuso de Brasília, ids e normalização de textos.
const crypto = require('crypto');

const FUSO = 'America/Sao_Paulo';

function agora(date = new Date()) {
    const partes = new Intl.DateTimeFormat('pt-BR', {
        timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const hh = partes.hour === '24' ? '00' : partes.hour;
    return {
        data: `${partes.day}/${partes.month}/${partes.year}`,
        hora: `${hh}:${partes.minute}`,
        horaNum: parseInt(hh, 10),
        iso: date.toISOString()
    };
}

function turnoPelaHora(horaNum) {
    return horaNum >= 7 && horaNum < 19 ? 'DIURNO' : 'NOTURNO';
}

function dataDeOntem(dataBR) {
    const [d, m, a] = dataBR.split('/').map(Number);
    return agora(new Date(Date.UTC(a, m - 1, d - 1, 15))).data;
}

function diaSeguinte(dataBR) {
    const [d, m, a] = dataBR.split('/').map(Number);
    return agora(new Date(Date.UTC(a, m - 1, d + 1, 15))).data;
}

// Data "oficial" do turno: o noturno que vira a meia-noite continua com a data em que começou
function dataDoTurno(turno, t = agora()) {
    return (turno === 'NOTURNO' && t.horaNum < 7) ? dataDeOntem(t.data) : t.data;
}

// Chave ordenável de um turno: "2026-11-14-1" (DIURNO=0, NOTURNO=1)
function chaveTurno(dataBR, turno) {
    if (!dataBR || !/^\d{2}\/\d{2}\/\d{4}$/.test(dataBR)) return '';
    const [d, m, a] = dataBR.split('/');
    return `${a}-${m}-${d}-${turno === 'NOTURNO' ? 1 : 0}`;
}

function novoId() {
    return crypto.randomBytes(6).toString('hex');
}

function semAcento(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Remove marcador "✓", "-", "•", "*" do início de uma linha
function limparMarcador(linha) {
    return String(linha || '').replace(/^[\s✓✔•\-\*–]+/, '').trim();
}

// "19:01H", "19h01", "19:01" → "19:01"
function normalizarHora(v) {
    const m = String(v || '').match(/(?<!\d)([01]?\d|2[0-3])\s*[:hH]\s*([0-5]\d)(?!\d)/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// "rjg9d19", "RJG 9D19", "GXM- 8B67" → "RJG-9D19"
const RE_PLACA = /\b([A-Z]{3})\s*-?\s*([0-9][A-Z0-9][0-9]{2})\b/;
function normalizarPlaca(v) {
    const m = String(v || '').toUpperCase().match(RE_PLACA);
    return m ? `${m[1]}-${m[2]}` : '';
}

// Várias placas num campo ("GXM- 8B67 / RBI- 458"). Nada é descartado:
// placa válida vai padronizada; placa incompleta vai como foi escrita e entra em "incompletas".
function lerPlacas(v) {
    const partes = String(v || '').toUpperCase().split(/\s*(?:\/|,|;|\s+E\s+|\n)\s*/).map(x => x.trim()).filter(Boolean);
    const placas = [], incompletas = [];
    for (const p of partes) {
        const ok = normalizarPlaca(p);
        if (ok) { if (!placas.includes(ok)) placas.push(ok); continue; }
        if (/\d/.test(p)) { const bruta = p.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' '); placas.push(bruta); incompletas.push(bruta); }
    }
    return { placas, incompletas, texto: placas.join(' / ') };
}

// Compara placas (aceita campo com várias placas)
function placasEmComum(a, b) {
    const k = v => lerPlacas(v).placas.map(p => p.replace(/[^A-Z0-9]/g, ''));
    const lb = k(b);
    return k(a).some(p => p && lb.includes(p));
}

// "T.OIL", "TOIL", "Petróleo" → "T-OIL" ; "T.ORE", "Minério" → "T-ORE"
function normalizarTerminal(v) {
    const n = semAcento(v).toUpperCase();
    if (/\bT[\s\-_.]*OIL\b|\bTOIL\b|PETROL|\bOIL\b/.test(n)) return 'T-OIL';
    if (/\bT[\s\-_.]*ORE\b|\bTORE\b|MINER|\bORE\b/.test(n)) return 'T-ORE';
    return '';
}

// Uniformiza hífens do WhatsApp (–, —, −) e espaços
function normalizarTexto(t) {
    return String(t || '').replace(/[‐-―−]/g, '-').replace(/\r/g, '');
}

module.exports = {
    FUSO, agora, turnoPelaHora, dataDeOntem, diaSeguinte, dataDoTurno, chaveTurno, novoId, semAcento,
    limparMarcador, normalizarHora, normalizarPlaca, lerPlacas, placasEmComum, normalizarTerminal, normalizarTexto
};
