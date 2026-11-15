// Gerador de planilha Excel (.xlsx) sem dependências.
// Uso: gerarXlsx([{ nome: 'Relatório', larguras: [28, 90], linhas: [['A', 'B'], ...], cabecalho: true }])
// Células: texto ou número. A primeira linha fica em negrito quando cabecalho = true;
// linhas que começam com { titulo: 'X' } viram uma linha de título em negrito.

const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// ZIP sem compressão (método "store"): suficiente para o Excel abrir
function zip(arquivos) {
    const partes = [], centrais = [];
    let offset = 0;
    for (const { nome, dados } of arquivos) {
        const nomeBuf = Buffer.from(nome, 'utf-8');
        const conteudo = Buffer.isBuffer(dados) ? dados : Buffer.from(dados, 'utf-8');
        const crc = crc32(conteudo);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(conteudo.length, 18); local.writeUInt32LE(conteudo.length, 22);
        local.writeUInt16LE(nomeBuf.length, 26); local.writeUInt16LE(0, 28);
        partes.push(local, nomeBuf, conteudo);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16); central.writeUInt32LE(conteudo.length, 20); central.writeUInt32LE(conteudo.length, 24);
        central.writeUInt16LE(nomeBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
        centrais.push(central, nomeBuf);
        offset += local.length + nomeBuf.length + conteudo.length;
    }
    const tamCentral = centrais.reduce((s, b) => s + b.length, 0);
    const fim = Buffer.alloc(22);
    fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(0, 4); fim.writeUInt16LE(0, 6);
    fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10);
    fim.writeUInt32LE(tamCentral, 12); fim.writeUInt32LE(offset, 16); fim.writeUInt16LE(0, 20);
    return Buffer.concat([...partes, ...centrais, fim]);
}

const esc = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function coluna(i) {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
}

// estilos: 0 normal (quebra linha), 1 negrito, 2 título grande, 3 cabeçalho com fundo
const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function planilha({ linhas, larguras = [], cabecalho = false }) {
    const cols = larguras.length ? `<cols>${larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const rows = linhas.map((linha, r) => {
        let estilo = 0, valores = linha;
        if (linha && !Array.isArray(linha) && linha.titulo !== undefined) { valores = [linha.titulo]; estilo = linha.grande ? 2 : 3; }
        else if (cabecalho && r === 0) estilo = 3;
        const cels = (valores || []).map((v, c) => {
            const ref = `${coluna(c)}${r + 1}`;
            if (v === null || v === undefined || v === '') return '';
            if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}" s="${estilo}"><v>${v}</v></c>`;
            return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        }).join('');
        return `<row r="${r + 1}">${cels}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

function gerarXlsx(abas) {
    const nomeAba = n => String(n || 'Planilha').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
    const arquivos = [
        { nome: '[Content_Types].xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
        { nome: '_rels/.rels', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { nome: 'xl/workbook.xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${abas.map((a, i) => `<sheet name="${esc(nomeAba(a.nome))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
        { nome: 'xl/_rels/workbook.xml.rels', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
        { nome: 'xl/styles.xml', dados: ESTILOS },
        ...abas.map((a, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, dados: planilha(a) }))
    ];
    return zip(arquivos);
}

module.exports = { gerarXlsx, crc32 };
