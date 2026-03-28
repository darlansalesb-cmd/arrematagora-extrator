/**
 * Cron interno - roda a extração todo dia às 6h (horário de Brasília)
 * Também roda imediatamente ao iniciar o container (primeira carga)
 */

const main = require('./extrair');

function log(msg) { console.log(`[CRON ${new Date().toISOString().substring(11,19)}] ${msg}`); }

// Calcula ms até próxima execução às 6h BRT (UTC-3)
function msUntilNext6am() {
  const now = new Date();
  const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const next = new Date(brt);
  next.setHours(6, 0, 0, 0);
  if (brt >= next) next.setDate(next.getDate() + 1);
  return next.getTime() - brt.getTime();
}

function schedule() {
  const ms = msUntilNext6am();
  const hours = Math.round(ms / 3600000 * 10) / 10;
  log(`Próxima execução em ${hours}h`);

  setTimeout(async () => {
    log('Iniciando extração agendada...');
    try {
      await main();
      log('Extração concluída.');
    } catch(e) {
      log('Erro na extração: ' + e.message);
    }
    schedule(); // Agendar próxima
  }, ms);
}

// Roda imediatamente na primeira vez
log('Container iniciado. Rodando extração inicial...');
main()
  .then(() => {
    log('Extração inicial concluída.');
    schedule();
  })
  .catch(e => {
    log('Erro na extração inicial: ' + e.message);
    schedule();
  });
