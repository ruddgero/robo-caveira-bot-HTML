// Leitor de planilha .xlsx sem dependências (zlib do próprio Node).
// lerXlsx(buffer) → [{ nome, linhas: [[valor, ...], ...] }]  (datas do Excel viram 'dd/mm/aaaa')
const zlib = require('zlib');

function arquivosDoZip(buf) {
    // fim do diretório central
    let fim = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
    if (fim < 0) throw new Error('Arquivo não é uma planilha .xlsx válida.');
    const total = buf.readUInt16LE(fim + 10);
    let p = buf.readUInt32LE(fim + 16);
    const mapa = new Map();
    for (let k = 0; k < total; k++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const metodo = buf.readUInt16LE(p + 10), tamComp = buf.readUInt32LE(p + 20);
        const nLen = buf.readUInt16LE(p + 28), eLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
        const nome = buf.slice(p + 46, p + 46 + nLen).toString('utf-8');
        mapa.set(nome, { metodo, tamComp, local });
        p += 46 + nLen + eLen + cLen;
    }
    return name => {
        const e = mapa.get(name);
        if (!e) return null;
        const ini = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
        const dados = buf.slice(ini, ini + e.tamComp);
        return (e.metodo === 8 ? zlib.inflateRawSync(dados) : dados).toString('utf-8');
    };
}

const desescapar = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
const textoDe = xml => [...String(xml || '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => desescapar(m[1])).join('');
function colunaIndice(ref) { const l = ref.replace(/\d+/g, ''); let n = 0; for (const ch of l) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function dataExcel(n) {
    const d = new Date(Math.round((n - 25569) * 864e5));
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function lerXlsx(buf) {
    const ler = arquivosDoZip(buf);
    const compart = [...String(ler('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textoDe(m[1]));
    // estilos com formato de data
    const estilos = String(ler('xl/styles.xml') || '');
    const fmtsData = new Set([14, 15, 16, 17, 22, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182]
        .filter(id => id < 164 || new RegExp(`numFmtId="${id}" formatCode="[^"]*[dmy][^"]*"`, 'i').test(estilos)));
    const xfs = [...(estilos.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || ['', ''])[1].matchAll(/<xf [^>]*numFmtId="(\d+)"/g)].map(m => +m[1]);
    const wb = String(ler('xl/workbook.xml') || '');
    const rels = String(ler('xl/_rels/workbook.xml.rels') || '');
    const abas = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(m => {
        const alvo = (rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${m[2]}"`)) || [])[1] || '';
        return { nome: desescapar(m[1]), caminho: 'xl/' + alvo.replace(/^\/?xl\//, '') };
    });
    return abas.map(({ nome, caminho }) => {
        const xml = String(ler(caminho) || '');
        const linhas = [];
        for (const r of xml.matchAll(/<row [^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
            const linha = [];
            for (const c of (r[2] || '').matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const attrs = c[1], corpo = c[2] || '';
                const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
                if (!ref) continue;
                const t = (attrs.match(/ t="(\w+)"/) || [])[1];
                const s = +((attrs.match(/ s="(\d+)"/) || [])[1] || 0);
                const v = (corpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
                let val = null;
                if (t === 's') val = compart[+v] ?? '';
                else if (t === 'inlineStr') val = textoDe(corpo);
                else if (t === 'str' || t === 'e') val = desescapar(v || '');
                else if (t === 'b') val = v === '1';
                else if (v !== undefined) { const n = +v; val = fmtsData.has(xfs[s]) && n > 20000 && n < 80000 ? dataExcel(n) : n; }
                linha[colunaIndice(ref)] = val;
            }
            linhas[+r[1] - 1] = linha;
        }
        return { nome, linhas: Array.from(linhas, l => l || []) };
    });
}

module.exports = { lerXlsx };
