// Utilitários: data/hora sempre no fuso de Brasília, ids e textos.
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

function novoId() {
    return crypto.randomBytes(6).toString('hex');
}

function semAcento(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Remove marcador "✓", "-", "•" do início de uma linha
function limparMarcador(linha) {
    return String(linha || '').replace(/^[\s✓✔•\-\*–]+/, '').trim();
}

module.exports = { FUSO, agora, turnoPelaHora, novoId, semAcento, limparMarcador };
