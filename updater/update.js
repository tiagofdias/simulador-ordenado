/**
 * Simulador de Domiciliação de Ordenado — Auto-Updater
 * 
 * Este script corre diariamente via GitHub Actions e:
 * 1. Consulta os sites oficiais dos bancos para verificar se as campanhas mudaram
 * 2. Consulta a taxa dos Certificados de Aforro no IGCP
 * 3. Atualiza o ficheiro data/banks.json se houver alterações
 * 4. Gera um log de cada execução
 * 
 * A abordagem é "best-effort": tenta extrair dados automaticamente,
 * mas se falhar (ex: site mudou de estrutura), mantém os dados anteriores
 * e regista o erro no log para revisão manual.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const DATA_PATH = join(ROOT, 'data', 'banks.json');
const CONFIG_PATH = join(__dirname, 'config.json');
const LOGS_DIR = join(__dirname, 'logs');

// ─── Ensure logs directory exists ───
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// ─── Log helper ───
const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
}

// ─── HTTP fetch with retry ───
async function fetchWithRetry(url, config, retries = 2) {
  const timeout = config.settings?.requestTimeoutMs || 15000;
  const userAgent = config.settings?.userAgent || 'SimuladorOrdenado/1.0';

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.5',
        }
      });

      clearTimeout(timer);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      return await resp.text();
    } catch (err) {
      if (attempt < retries) {
        log(`  ⚠ Tentativa ${attempt + 1} falhou para ${url}: ${err.message}. A tentar novamente...`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
}

// ─── Check if a campaign page is still active ───
function checkPageForCampaign(html, bankId) {
  const $ = cheerio.load(html);
  const text = $('body').text().toLowerCase();

  // Common indicators that a campaign is expired
  const expiredIndicators = [
    'campanha terminada',
    'campanha encerrada',
    'promoção terminada',
    'promoção expirada',
    'já não está disponível',
    'esta campanha já terminou',
    'campanha finalizada',
    'oferta terminada',
    'período de adesão terminou',
    'adesão encerrada'
  ];

  // Common indicators that a campaign is active
  const activeIndicators = [
    'aderir agora',
    'abrir conta',
    'subscrever',
    'aproveita já',
    'domiciliar ordenado',
    'domiciliação de ordenado',
    'quero aderir',
    'abra já a sua conta'
  ];

  const hasExpiredSignal = expiredIndicators.some(indicator => text.includes(indicator));
  const hasActiveSignal = activeIndicators.some(indicator => text.includes(indicator));

  // Try to extract dates from the page
  const datePattern = /(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})/g;
  const dates = [];
  let match;
  while ((match = datePattern.exec(text)) !== null) {
    const d = new Date(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`);
    if (!isNaN(d.getTime())) dates.push(d);
  }

  // Also try "até DD de MES de YYYY" pattern
  const monthNames = {
    'janeiro': '01', 'fevereiro': '02', 'março': '03', 'abril': '04',
    'maio': '05', 'junho': '06', 'julho': '07', 'agosto': '08',
    'setembro': '09', 'outubro': '10', 'novembro': '11', 'dezembro': '12'
  };
  const ptDatePattern = /até\s+(\d{1,2})\s+de\s+(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(20\d{2})/gi;
  while ((match = ptDatePattern.exec(text)) !== null) {
    const month = monthNames[match[2].toLowerCase()];
    if (month) {
      const d = new Date(`${match[3]}-${month}-${match[1].padStart(2, '0')}`);
      if (!isNaN(d.getTime())) dates.push(d);
    }
  }

  // Try to find salary values
  const salaryPattern = /(?:ordenado|salário|reforma).*?(?:mínimo|mín\.?|superior|igual).*?(\d[\d\s.]*)\s*€/gi;
  const salaryValues = [];
  while ((match = salaryPattern.exec(text)) !== null) {
    const val = parseInt(match[1].replace(/[\s.]/g, ''));
    if (val >= 500 && val <= 10000) salaryValues.push(val);
  }

  // Try to find bonus amounts
  const bonusPattern = /(\d[\d\s.]*)\s*€\s*(?:brutos|líquidos|em\s+(?:cartão|voucher|vale))/gi;
  const bonusValues = [];
  while ((match = bonusPattern.exec(text)) !== null) {
    const val = parseInt(match[1].replace(/[\s.]/g, ''));
    if (val >= 50 && val <= 5000) bonusValues.push(val);
  }

  // Try to find interest rates
  const ratePattern = /(\d+(?:[,.]\d+)?)\s*%\s*(?:TANB|brut|líquid)/gi;
  const rates = [];
  while ((match = ratePattern.exec(text)) !== null) {
    const val = parseFloat(match[1].replace(',', '.'));
    if (val > 0 && val < 20) rates.push(val);
  }

  return {
    hasExpiredSignal,
    hasActiveSignal,
    dates: dates.sort((a, b) => b - a),
    salaryValues,
    bonusValues,
    rates,
    pageTitle: $('title').text().trim(),
    status: hasExpiredSignal ? 'likely_expired' : (hasActiveSignal ? 'likely_active' : 'uncertain')
  };
}

// ─── Try to fetch CA rate from IGCP ───
async function fetchCARate(config) {
  log('📊 A verificar taxa dos Certificados de Aforro...');

  try {
    const html = await fetchWithRetry(config.sources.igcp_ca.url, config);
    const $ = cheerio.load(html);

    // Look for the rate in tables or text
    const text = $('body').text();

    // Pattern: look for percentage values near "Série F" or "taxa base"
    const patterns = [
      /[Ss]érie\s*F[^]*?(\d+[,.]\d+)\s*%/,
      /taxa\s+base[^]*?(\d+[,.]\d+)\s*%/,
      /(\d+[,.]\d+)\s*%\s*[^]*?[Ss]érie\s*F/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const rate = parseFloat(match[1].replace(',', '.')) / 100;
        if (rate > 0 && rate < 0.1) {
          log(`  ✅ Taxa CA encontrada: ${(rate * 100).toFixed(3)}%`);
          return rate;
        }
      }
    }

    log('  ⚠ Não foi possível extrair a taxa CA automaticamente');
    return null;
  } catch (err) {
    log(`  ❌ Erro ao consultar IGCP: ${err.message}`);
    return null;
  }
}

// ─── Check each bank's page ───
async function checkBank(bankId, bankData, config) {
  const source = config.sources[bankId];
  if (!source) {
    log(`  ⏭ Sem fonte configurada para ${bankId}`);
    return null;
  }

  log(`🏦 A verificar ${bankData.name}...`);

  try {
    const html = await fetchWithRetry(source.url, config);
    const analysis = checkPageForCampaign(html, bankId);

    log(`  📄 Título: ${analysis.pageTitle}`);
    log(`  📊 Status: ${analysis.status}`);
    if (analysis.dates.length > 0) {
      log(`  📅 Datas encontradas: ${analysis.dates.map(d => d.toISOString().split('T')[0]).join(', ')}`);
    }
    if (analysis.bonusValues.length > 0) {
      log(`  💰 Valores de bónus: ${analysis.bonusValues.join(', ')} €`);
    }
    if (analysis.rates.length > 0) {
      log(`  📈 Taxas encontradas: ${analysis.rates.join(', ')}%`);
    }

    return analysis;
  } catch (err) {
    log(`  ❌ Erro ao verificar ${bankData.name}: ${err.message}`);
    return null;
  }
}

// ─── Main update logic ───
async function main() {
  log('═══════════════════════════════════════════');
  log('🚀 Início da atualização automática');
  log('═══════════════════════════════════════════');

  // Load current data and config
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));

  let hasChanges = false;
  const changes = [];

  // 1. Check CA rate
  const newCARate = await fetchCARate(config);
  if (newCARate !== null && data.caRate?.serieF) {
    const oldRate = data.caRate.serieF.baseRate;
    if (Math.abs(newCARate - oldRate) > 0.0001) {
      log(`  📝 Taxa CA alterada: ${(oldRate * 100).toFixed(3)}% → ${(newCARate * 100).toFixed(3)}%`);

      data.caRate.serieF.baseRate = newCARate;
      data.caRate.serieF.displayRate = (newCARate * 100).toFixed(3).replace('.', ',') + '%';
      data.caRate.serieF.month = new Date().toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });
      data.caRate.serieF.label = `Taxa base CA Série F — ${data.caRate.serieF.month}`;

      // Recalculate net approximations
      const netRate = 1 - 0.28;
      const netYr1 = (Math.pow(1 + newCARate * netRate / 4, 4) - 1) * 100;
      const netYr2 = (Math.pow(1 + (newCARate + 0.0025) * netRate / 4, 4) - 1) * 100;
      data.caRate.serieF.netYear1Approx = netYr1.toFixed(2).replace('.', ',') + '%';
      data.caRate.serieF.netYear2Approx = netYr2.toFixed(2).replace('.', ',') + '%';

      hasChanges = true;
      changes.push(`Taxa CA: ${(oldRate * 100).toFixed(3)}% → ${(newCARate * 100).toFixed(3)}%`);
    } else {
      log('  ✅ Taxa CA sem alterações');
    }
  }

  // 2. Check each bank
  const today = new Date();
  for (const bank of data.banks) {
    const analysis = await checkBank(bank.id, bank, config);

    if (!analysis) continue;

    // Auto-expire if the page says expired
    if (analysis.status === 'likely_expired' && bank.status === 'active') {
      log(`  📝 ${bank.name}: campanha parece expirada — a marcar como expirada`);
      bank.status = 'expired';
      bank.statusLabel = `Expirado (detetado automaticamente em ${today.toISOString().split('T')[0]})`;
      hasChanges = true;
      changes.push(`${bank.name}: marcado como expirado`);
    }

    // Check if expiry date has passed
    if (bank.expiryDate && bank.status === 'active') {
      const expiry = new Date(bank.expiryDate);
      if (today > expiry) {
        log(`  📝 ${bank.name}: data de expiração ultrapassada (${bank.expiryDate})`);
        bank.status = 'expired';
        bank.statusLabel = `Expirado em ${new Date(bank.expiryDate).toLocaleDateString('pt-PT')}`;
        hasChanges = true;
        changes.push(`${bank.name}: expirado (data ${bank.expiryDate} ultrapassada)`);
      }
    }

    // Check for potential new dates (future expiry dates)
    if (analysis.dates.length > 0 && bank.status === 'active') {
      const futureDates = analysis.dates.filter(d => d > today);
      if (futureDates.length > 0) {
        const latestFuture = futureDates[0].toISOString().split('T')[0];
        if (bank.expiryDate && latestFuture !== bank.expiryDate) {
          log(`  ℹ️ ${bank.name}: possível nova data de expiração detetada: ${latestFuture} (atual: ${bank.expiryDate})`);
          // Don't auto-update dates — just log for review
          changes.push(`${bank.name}: possível nova data de expiração: ${latestFuture} (requer verificação manual)`);
        }
      }
    }

    // Bankinter: check rates
    if (bank.id === 'bankinter' && analysis.rates.length > 0) {
      const currentY1 = bank.calcParams.year1Rate * 100;
      if (!analysis.rates.includes(currentY1)) {
        log(`  ℹ️ Bankinter: taxas na página (${analysis.rates.join(', ')}%) diferem da atual (${currentY1}%). Requer verificação manual.`);
        changes.push(`Bankinter: taxas podem ter mudado (encontrado: ${analysis.rates.join(', ')}%, atual: ${currentY1}%)`);
      }
    }

    // Sanitize and enforce concise condition notes formatting
    if (bank.conditionNote) {
      // Remove conversational disclaimers and multi-sentence fluff
      bank.conditionNote = bank.conditionNote
        .replace(/Fidelização \d+ meses ·\s*/g, '')
        .replace(/Sem comissões de manutenção ·\s*/g, '')
        .replace(/\s*— nem todas as entidades patronais conseguem fazer isso, pelo que é essencial confirmar com o departamento de RH\/contabilidade antes de aderir/g, '')
        .trim();
    }
    if (bank.newClientNote) {
      bank.newClientNote = bank.newClientNote
        .replace(/^Novo cliente:\s*/i, '')
        .trim();
    }

    // Small delay between requests to be polite
    await new Promise(r => setTimeout(r, 1500));
  }

  // 3. Update lastUpdated date
  if (hasChanges) {
    data.lastUpdated = today.toISOString().split('T')[0];
    data.dataVersion = (data.dataVersion || 1) + 1;
  }

  // 4. Write updated data
  if (hasChanges) {
    writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
    log('');
    log('═══════════════════════════════════════════');
    log('✅ Dados atualizados com sucesso!');
    log('Alterações:');
    changes.forEach(c => log(`  • ${c}`));
  } else {
    log('');
    log('═══════════════════════════════════════════');
    log('✅ Sem alterações — dados já estão atualizados.');
    if (changes.length > 0) {
      log('ℹ️ Notas (não resultaram em alterações automáticas):');
      changes.forEach(c => log(`  • ${c}`));
    }
  }

  log('═══════════════════════════════════════════');

  // 5. Save log
  const logDate = today.toISOString().split('T')[0];
  const logPath = join(LOGS_DIR, `update-${logDate}.log`);
  writeFileSync(logPath, logLines.join('\n'), 'utf-8');
  log(`📝 Log guardado em: ${logPath}`);
}

main().catch(err => {
  log(`❌ ERRO FATAL: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
