const puppeteer = require('puppeteer');
const https = require('https');

// =============================================
// CONFIG
// =============================================
const SB_URL = 'https://jzcoxdgbtjitjwrppbbf.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6Y294ZGdidGppdGp3cnBwYmJmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDg2ODE4NiwiZXhwIjoyMDgwNDQ0MTg2fQ.MSxJyxW9YMjm3wUsNEmtmLuzf04xf_Lx2JzYjfJthro';

const ESTADOS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];

// =============================================
// HELPERS
// =============================================
function log(msg) { console.log(`[${new Date().toISOString().substring(11,19)}] ${msg}`); }

function supabasePost(table, body, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL);
    const opts = {
      hostname: url.hostname, port: 443, method: 'POST',
      path: `/rest/v1/${table}${params ? '?' + params : ''}`,
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal,resolution=merge-duplicates'
      }
    };
    const data = JSON.stringify(body);
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

function parseCSV(text) {
  let sep = ';';
  const fl = text.split('\n')[0];
  if (fl.split(';').length < 3) sep = ',';
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const hds = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vs = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
    if (vs.length < 3) continue;
    const row = {};
    hds.forEach((h, idx) => { row[h] = vs[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function findCol(hds, ...kws) {
  for (const c of hds) {
    const cl = c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    for (const kg of kws) {
      const ks = Array.isArray(kg) ? kg : [kg];
      if (ks.every(k => cl.includes(k))) return c;
    }
  }
  return null;
}

function pNum(v) {
  if (!v || v === '-' || v === '') return null;
  let s = String(v).replace(/R\$\s*/gi, '').replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function sHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h = h & h; }
  return Math.abs(h).toString(36) + str.length.toString(36);
}

// =============================================
// MAIN
// =============================================
async function main() {
  log('========================================');
  log('  ARREMATAGORA - Extrator Caixa');
  log('========================================');

  // Chrome com stealth (sem proxy)
  log('Abrindo Chrome headless...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const page = await browser.newPage();
  
  // Stealth: esconder que é automação
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' });

  const stats = {};
  const erros = [];
  let totalRecords = 0;
  let totalUpserted = 0;

  try {
    // Visitar página pra passar pelo WAF
    log('Acessando site da Caixa...');
    await page.goto('https://venda-imoveis.caixa.gov.br/sistema/download-lista.asp', {
      waitUntil: 'networkidle2', timeout: 30000
    });
    await new Promise(r => setTimeout(r, 5000));
    
    const title = await page.title();
    const pageUrl = page.url();
    log('Título: ' + title);
    log('URL: ' + pageUrl);
    
    // Checa se passou pelo WAF
    if (title.includes('Azion') || title.includes('error')) {
      log('❌ WAF bloqueou. Tentando aguardar challenge...');
      await new Promise(r => setTimeout(r, 10000));
      await page.reload({ waitUntil: 'networkidle2' });
      await new Promise(r => setTimeout(r, 5000));
      const title2 = await page.title();
      log('Título após reload: ' + title2);
      if (title2.includes('Azion') || title2.includes('error')) {
        throw new Error('WAF Azion bloqueou o acesso');
      }
    }
    
    log('Site acessado com sucesso!');

    // Baixar CSVs
    for (const uf of ESTADOS) {
      log(`[${uf}] Baixando...`);
      try {
        const csv = await page.evaluate(async (u) => {
          try {
            const r = await fetch('/listaweb/Lista_imoveis_' + u + '.csv');
            if (!r.ok) return { error: 'HTTP ' + r.status };
            const t = await r.text();
            if (t.indexOf('<!DOCTYPE') !== -1) return { error: 'HTML retornado' };
            return { data: t, len: t.length };
          } catch(e) { return { error: e.message }; }
        }, uf);

        if (csv.error) {
          log(`[${uf}] ❌ ${csv.error}`);
          erros.push({ uf, msg: csv.error });
          continue;
        }

        if (!csv.data || csv.len < 50) {
          log(`[${uf}] ❌ CSV vazio`);
          erros.push({ uf, msg: 'CSV vazio' });
          continue;
        }

        // Parsear
        const rows = parseCSV(csv.data);
        if (rows.length === 0) {
          log(`[${uf}] ❌ Parse vazio`);
          erros.push({ uf, msg: 'Parse vazio' });
          continue;
        }

        const hds = Object.keys(rows[0]);
        const cUf = findCol(hds, 'uf', 'estado', 'sg_uf');
        const cCid = findCol(hds, 'cidade', 'municipio', 'no_cidade');
        const cBai = findCol(hds, 'bairro');
        const cEnd = findCol(hds, 'endereco', 'logradouro');
        const cTip = findCol(hds, ['tipo', 'imovel'], 'tipo_imovel', 'ds_tipo');
        const cMod = findCol(hds, 'modalidade', ['tipo', 'venda'], 'mod_venda');
        const cAv = findCol(hds, ['avalia', 'valor'], ['vr', 'avalia'], 'avaliacao');
        const cVe = findCol(hds, ['venda', 'valor'], ['vr', 'venda'], ['minimo', 'venda']);
        const cAP = findCol(hds, ['area', 'priv']);
        const cAT = findCol(hds, ['area', 'terr'], ['area', 'total']);
        const cQ = findCol(hds, 'quarto', 'dormit');
        const cG = findCol(hds, 'garagem', 'vaga');
        const cS = findCol(hds, 'situacao', 'ocupacao');
        const cF = findCol(hds, 'financ');
        const cFg = findCol(hds, 'fgts');
        const cEd = findCol(hds, 'edital', 'link');
        const cN = findCol(hds, ['numero', 'imovel'], 'nu_imovel', 'referencia');

        const registros = [];
        for (const row of rows) {
          const vAv = cAv ? pNum(row[cAv]) : null;
          const vVe = cVe ? pNum(row[cVe]) : null;
          let desc = null, econ = null;
          if (vAv && vVe && vAv > 0) {
            desc = Math.round(((vAv - vVe) / vAv) * 1000) / 10;
            econ = Math.round((vAv - vVe) * 100) / 100;
          }
          const hi = [cUf?row[cUf]:uf, cCid?row[cCid]:'', cBai?row[cBai]:'', cEnd?row[cEnd]:'', cN?row[cN]:'', cTip?row[cTip]:'', String(vVe||'')].join('|');
          const hash = sHash(hi);
          const brutos = {};
          for (const h of hds) { if (row[h]) brutos[h] = row[h]; }

          registros.push({
            hash,
            uf: cUf ? (row[cUf]||uf).toUpperCase().substring(0,2) : uf,
            cidade: cCid ? row[cCid] || null : null,
            bairro: cBai ? row[cBai] || null : null,
            endereco: cEnd ? row[cEnd] || null : null,
            tipo_imovel: cTip ? row[cTip] || null : null,
            modalidade_venda: cMod ? row[cMod] || null : null,
            valor_avaliacao: vAv,
            valor_venda: vVe,
            desconto_pct: desc,
            economia_reais: econ,
            area_privativa: cAP ? pNum(row[cAP]) : null,
            area_terreno: cAT ? pNum(row[cAT]) : null,
            quartos: cQ ? (parseInt(row[cQ]) || null) : null,
            garagem: cG ? row[cG] || null : null,
            situacao: cS ? row[cS] || null : null,
            aceita_financiamento: cF ? row[cF] || null : null,
            aceita_fgts: cFg ? row[cFg] || null : null,
            link_edital: cEd ? row[cEd] || null : null,
            numero_imovel: cN ? row[cN] || null : null,
            dados_brutos: JSON.stringify(brutos),
            ativo: true,
            data_extracao: new Date().toISOString().split('T')[0]
          });
        }

        stats[uf] = registros.length;
        totalRecords += registros.length;
        log(`[${uf}] ✅ ${registros.length} imóveis`);

        // Upsert batches de 500
        for (let i = 0; i < registros.length; i += 500) {
          const batch = registros.slice(i, i + 500);
          try {
            const resp = await supabasePost('imoveis_caixa', batch, 'on_conflict=hash');
            if (resp.status >= 200 && resp.status < 300) {
              totalUpserted += batch.length;
            } else {
              log(`[${uf}] ⚠️ Upsert ${resp.status}: ${resp.data.substring(0, 100)}`);
              erros.push({ uf, msg: 'Upsert ' + resp.status });
            }
          } catch(e) {
            erros.push({ uf, msg: 'Upsert: ' + e.message });
          }
          await new Promise(r => setTimeout(r, 300));
        }

        await new Promise(r => setTimeout(r, 500));
      } catch(e) {
        log(`[${uf}] ❌ ${e.message}`);
        erros.push({ uf, msg: e.message });
      }
    }
  } catch(e) {
    log('ERRO GERAL: ' + e.message);
    erros.push({ msg: e.message });
  }

  await browser.close();

  // Salvar log
  try {
    await supabasePost('extracoes_log', {
      total_baixados: totalRecords,
      total_novos: 0,
      total_atualizados: totalUpserted,
      total_desativados: 0,
      estados_processados: Object.keys(stats),
      erros: JSON.stringify(erros),
      duracao_segundos: 0
    });
  } catch(e) {}

  log('========================================');
  log(`  TOTAL: ${totalRecords} imóveis`);
  log(`  UPSERTED: ${totalUpserted}`);
  log(`  ESTADOS OK: ${Object.keys(stats).length}/27`);
  log(`  ERROS: ${erros.length}`);
  log('========================================');
}

main().catch(e => { console.error(e); process.exit(1); });
module.exports = main;
