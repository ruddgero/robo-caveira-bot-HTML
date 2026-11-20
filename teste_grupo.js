// =====================================================================
// TESTE COM A CONVERSA REAL DO GRUPO
// Uso:  node teste_grupo.js "Conversa do WhatsApp com EQUIPE AZUL.txt"
//   (WhatsApp › grupo › ⋮ › Mais › Exportar conversa › Sem mídia)
//
// Passa todas as mensagens pelo robô, turno a turno, numa pasta separada (não mexe nos dados reais)
// e grava em ./saida_teste/:
//   resumo.txt              → o que o robô entendeu, o que ficou "a confirmar" e o que ignorou
//   relatorio_<turno>.txt   → item 6 de cada turno como o robô montaria
//   planilha_<turno>.xlsx   → planilha T-ORE / T-OIL de cada turno
// =====================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

const arquivo = process.argv[2];
if (!arquivo || !fs.existsSync(arquivo)) {
    console.log('Uso: node teste_grupo.js "Conversa do WhatsApp com GRUPO.txt"');
    process.exit(1);
}

// ambiente isolado
delete process.env.FIREBASE_CREDENTIALS;
process.env.CAVEIRA_DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'caveira-teste-'));
process.env.CAVEIRA_SIMULACAO = '1';

const store = require('./store');
const R = require('./relatorio');
const N = require('./nucleo');
const NV = require('./navios');
const { gerarXlsx } = require('./xlsx');
const { turnoPelaHora, diaSeguinte } = require('./util');

// ---------------------------------------------------------------------
// Leitura da exportação (Android: "19/11/2026 14:50 - Nome: texto" | iPhone: "[19/11/2026, 14:50:12] Nome: texto")
// ---------------------------------------------------------------------
const RE_ANDROID = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),? (\d{1,2}:\d{2})(?::\d{2})? - ([^:]{1,60}): ([\s\S]*)$/;
const RE_IOS = /^‎?\[(\d{1,2}\/\d{1,2}\/\d{2,4}),? (\d{1,2}:\d{2})(?::\d{2})?\] ([^:]{1,60}): ([\s\S]*)$/;
const APAGADA = /^(<?mensagem apagada>?|esta mensagem foi apagada|essa mensagem foi apagada|voc[eê] apagou esta mensagem|this message was deleted)\.?$/i;
const MIDIA = /^<(m[ií]dia oculta|arquivo de m[ií]dia oculto|media omitted)>$|\(arquivo anexado\)$/i;
const EDITADA = /\s*<(mensagem editada|esta mensagem foi editada|this message was edited)>\s*$/i;

function lerExportacao(texto) {
    const msgs = [];
    let atual = null;
    for (const linha of texto.replace(/\r/g, '').split('\n')) {
        const m = linha.match(RE_ANDROID) || linha.match(RE_IOS);
        if (m) {
            const [d, mm, a] = m[1].split('/');
            const ano = a.length === 2 ? '20' + a : a;
            const [h, mi] = m[2].split(':');
            atual = { data: `${d.padStart(2, '0')}/${mm.padStart(2, '0')}/${ano}`, hora: `${h.padStart(2, '0')}:${mi}`, autor: m[3].trim(), texto: m[4] };
            msgs.push(atual);
        } else if (atual) {
            atual.texto += '\n' + linha;
        }
    }
    return msgs.map((m, i) => {
        const editada = EDITADA.test(m.texto);
        const t = m.texto.replace(EDITADA, '').trim();
        const [d, mm, a] = m.data.split('/');
        const ts = new Date(`${a}-${mm}-${d}T${m.hora}:00-03:00`).getTime();
        return { ...m, id: `exp${i}`, texto: t, editada, ts, apagada: APAGADA.test(t), midia: MIDIA.test(t) };
    });
}

// turno de cada mensagem (07–19 diurno; 19–07 noturno, que pertence ao dia em que começou)
function turnoDa(m) {
    const h = parseInt(m.hora, 10);
    const turno = turnoPelaHora(h);
    let data = m.data;
    if (turno === 'NOTURNO' && h < 7) {
        const [d, mm, a] = data.split('/').map(Number);
        const ontem = new Date(Date.UTC(a, mm - 1, d - 1));
        data = `${String(ontem.getUTCDate()).padStart(2, '0')}/${String(ontem.getUTCMonth() + 1).padStart(2, '0')}/${ontem.getUTCFullYear()}`;
    }
    return { turno, data, chave: `${data.split('/').reverse().join('-')}_${turno}` };
}

(async () => {
    store.iniciar();
    await N.carregar();
    const msgs = lerExportacao(fs.readFileSync(arquivo, 'utf-8'));
    const saida = path.join(__dirname, 'saida_teste');
    fs.mkdirSync(saida, { recursive: true });

    const porTurno = new Map();
    for (const m of msgs) {
        let t = turnoDa(m);
        // relatório de turno postado no grupo pertence ao turno escrito no cabeçalho (ex.: o DIURNO postado às 19:05)
        if (!m.apagada && R.ehRelatorioDeTurno(m.texto)) {
            const tu = R.turnoDoTexto(m.texto), da = R.dataDoTexto(m.texto);
            if (tu && da) t = { turno: tu, data: da, chave: `${da.split('/').reverse().join('-')}_${tu}` };
        }
        if (!porTurno.has(t.chave)) porTurno.set(t.chave, { ...t, msgs: [] });
        porTurno.get(t.chave).msgs.push(m);
    }
    for (const t of porTurno.values()) t.msgs.sort((a, b) => R.ehRelatorioDeTurno(a.texto) - R.ehRelatorioDeTurno(b.texto) || a.ts - b.ts);

    const resumo = [];
    const tot = { msgs: msgs.length, apagadas: 0, midia: 0, relatorios: 0, operacoes: 0, confirmar: 0, ignoradas: 0, outras: 0 };
    let navios = { tore: [], toil: [] };

    for (const [, t] of [...porTurno].sort((a, b) => a[0].localeCompare(b[0]))) {
        // ficha do turno (navios do turno anterior continuam; só as manobras ficam)
        const f = R.fichaVazia(N.estado.config);
        f.turno = t.turno; f.data = t.data;
        f.navios = JSON.parse(JSON.stringify(navios));
        N.estado.ficha = f;
        const linhasTurno = [`\n===== ${t.turno} ${t.data} (${t.msgs.length} mensagens) =====`];

        for (const m of t.msgs) {
            if (m.apagada) { tot.apagadas++; continue; }
            if (m.midia || !m.texto) { tot.midia++; continue; }
            // relatório de turno postado no grupo: usa a seção 6 dele (manobras validadas)
            if (R.ehRelatorioDeTurno(m.texto)) {
                tot.relatorios++;
                const lido = R.lerRelatorio(m.texto).dados;
                const fa = N.estado.ficha;
                for (const k of ['tore', 'toil']) for (const n of lido.navios[k]) {
                    const manobras = n.linhas.filter(l => NV.lerManobra(l, fa));
                    if (!n.navio || !manobras.length) continue;
                    let alvo = fa.navios[k].find(x => R.chaveNavio(x.navio) === R.chaveNavio(n.navio));
                    if (!alvo) { alvo = { id: `n${Math.random()}`, navio: n.navio, linhas: [] }; fa.navios[k].push(alvo); }
                    for (const l of manobras) if (!alvo.linhas.includes(l)) alvo.linhas.push(l);
                }
                linhasTurno.push(`  📄 ${m.hora} relatório de turno de ${m.autor} (manobras lidas)`);
                continue;
            }
            await N.receberMensagem({ id: m.id, chatId: 'teste@g.us', grupoNome: 'TESTE', autor: m.autor, texto: m.texto, timestamp: m.ts, historico: false });
            const item = N.estado.entrada.find(e => e.id === m.id);
            if (!item) continue;
            const curto = m.texto.replace(/\s+/g, ' ').slice(0, 90);
            if (item.status === 'usado') { tot.operacoes++; linhasTurno.push(`  ✅ ${m.hora} ${m.autor}: ${item.destino} — "${curto}"`); }
            else if (String(item.destino || '').startsWith('⚠️')) { tot.confirmar++; linhasTurno.push(`  ⚠️ ${m.hora} ${m.autor}: ${item.destino} — "${curto}"`); }
            else if (item.status === 'ignorado') tot.ignoradas++;
            else { tot.outras++; linhasTurno.push(`  • ${m.hora} ${m.autor}: sugestão ${item.sugestao} — "${curto}"`); }
        }

        // item 6 do turno e planilha
        const ficha = N.estado.ficha;
        const texto = R.formatarRelatorio(ficha, []);
        const item6 = texto.split('*6. MOVIMENTAÇÃO DE NAVIOS*')[1]?.split('*7.')[0] || '';
        fs.writeFileSync(path.join(saida, `relatorio_${t.chave}.txt`), '6. MOVIMENTAÇÃO DE NAVIOS' + item6.replace(/\*/g, ''));
        const ops = N.estado.operacoes.filter(o => o.fichaId === ficha.id);
        const linhas = NV.atualizarEstadias(N.estado.estadias, ficha, ops);
        const pub = { turno: t.turno, data: t.data, geradoEm: 'teste', linhas, resumo: NV.resumoTurno(linhas, ops) };
        if (linhas.length) fs.writeFileSync(path.join(saida, `planilha_${t.chave}.xlsx`), gerarXlsx(NV.abasPlanilha(pub)));
        linhasTurno.push(`  🚢 planilha: ${linhas.length} linha(s) · ${ops.length} operação(ões)`);
        resumo.push(...linhasTurno);

        // próximo turno herda os navios (sem as linhas das operações deste turno)
        const linhasOps = new Set(ops.map(o => o.linhaNavio?.linha).filter(Boolean));
        const saiu = n => (n.linhas || []).some(l => NV.lerManobra(l, ficha)?.tipo === 'DESATRACACAO');
        const copiar = l => (l || []).filter(n => !saiu(n)).map(n => ({ ...n, linhas: (n.linhas || []).filter(x => !linhasOps.has(x)) })).filter(n => n.linhas.length);
        navios = { tore: copiar(ficha.navios.tore), toil: copiar(ficha.navios.toil) };
    }

    const cab = [
        'TESTE COM A CONVERSA DO GRUPO',
        `Arquivo: ${path.basename(arquivo)}`,
        `Mensagens: ${tot.msgs} · turnos: ${porTurno.size}`,
        `✅ viraram operação/saída/retorno automaticamente: ${tot.operacoes}`,
        `⚠️ ficaram "a confirmar": ${tot.confirmar}`,
        `• outras sugestões (atividade, aviso, navio…): ${tot.outras}`,
        `ignoradas (bom dia, ok…): ${tot.ignoradas} · apagadas: ${tot.apagadas} · mídia: ${tot.midia} · relatórios de turno lidos: ${tot.relatorios}`
    ];
    fs.writeFileSync(path.join(saida, 'resumo.txt'), [...cab, ...resumo].join('\n'));
    console.log(cab.join('\n'));
    console.log(`\nDetalhes em ${saida}${path.sep}resumo.txt`);
    process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
