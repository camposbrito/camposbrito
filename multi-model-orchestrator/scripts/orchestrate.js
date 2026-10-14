#!/usr/bin/env node
/**
 * 🧠 Master Pipeline Orchestrator (multi-model-orchestrator)
 *
 * Executa de ponta a ponta o Gate de Qualidade e Orquestração da Skill:
 *  1. [Fase 2 - Harness] Verifica (e opcionalmente inicializa) o Test Harness Real (Zero DB Mocks / Zero .skip).
 *  2. [Pilar Infra - Opcional] Dispara geração de infraestrutura via DeepSeek / GPT-OSS no OpenCode se --infra-prompt for passado.
 *  3. [Fase 3 - Auditor Clínico] Executa o scanner estático Anti-Malandragem + Revisão Clínica Zero-Trust via OpenCode (Claude 5.5 / Free Fallback).
 *  4. [Telemetria B2Sync] Envia o relatório consolidado para o celular (AGY Hub) e Dashboard (AGY Bridge).
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const getArg = (flag, def = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const targetPath = path.resolve(getArg('--path', process.cwd()));
const auditModel = getArg('--audit-model', 'claude-sonnet');
const infraPrompt = getArg('--infra-prompt', '');
const initHarness = args.includes('--init-harness');
const dryRun = args.includes('--dry-run');

const scriptsDir = __dirname;
const harnessScript = path.join(scriptsDir, 'harness-builder.js');
const auditScript = path.join(scriptsDir, 'audit-runner.js');
const b2syncScript = '/home/master/.gemini/config/skills/b2sync-bridge/scripts/b2sync-net.js';

function runStep(title, cmd, cmdArgs) {
  console.log(`\n========================================================================`);
  console.log(`▶️  ${title}`);
  console.log(`========================================================================`);
  const res = spawnSync(cmd, cmdArgs, {
    cwd: targetPath,
    stdio: 'inherit',
    encoding: 'utf-8'
  });
  return res.status === 0;
}

function main() {
  console.log(`🧠 [Multi-Model Orchestrator] Iniciando Pipeline Completo em: ${targetPath}`);

  // 1. Fase 2: Harness Real (Init opcional + Verify obrigatório)
  const harnessArgs = ['--path', targetPath, '--verify'];
  if (initHarness) harnessArgs.push('--init');
  const harnessOk = runStep('ETAPA 1/3: Verificação do Test Harness Real (Fase 2 - Anti-Mock)', 'node', [harnessScript, ...harnessArgs]);

  // 2. Pilar Infra (Opcional): DeepSeek / GPT-OSS 120B via OpenCode
  let infraOk = true;
  if (infraPrompt) {
    infraOk = runStep(
      'ETAPA EXTRA: Geração de Infraestrutura (DeepSeek / GPT-OSS via OpenCode)',
      'node',
      [auditScript, '--mode', 'infra', '--path', targetPath, '--prompt', infraPrompt]
    );
  }

  // 3. Fase 3: Auditoria Clínica DevSecOps (Claude 5.5 via OpenCode + Static Scanner)
  const auditArgs = ['--path', targetPath, '--model', auditModel];
  if (dryRun) auditArgs.push('--dry-run');
  const auditOk = runStep('ETAPA 2/3: Auditoria Clínica DevSecOps (Fase 3 - Claude / OpenCode)', 'node', [auditScript, ...auditArgs]);

  // 4. Notificação B2Sync Hub & Bridge
  const projectName = path.basename(targetPath);
  const allPassed = harnessOk && infraOk && auditOk;
  const statusTitle = allPassed
    ? `✅ Orquestração Concluída: ${projectName}`
    : `⚠️ Alerta na Orquestração: ${projectName}`;
  const statusContent = `Pipeline Multi-Modelo executado em ${projectName}. Harness Real: ${harnessOk ? 'OK' : 'FALHA'} | Auditoria Clínica (Fase 3): ${auditOk ? 'OK' : 'REVISAR'}.`;

  if (fs.existsSync(b2syncScript)) {
    runStep('ETAPA 3/3: Notificação AGY Hub & Bridge', 'node', [
      b2syncScript,
      'notify',
      '--title',
      statusTitle,
      '--content',
      statusContent
    ]);
  }

  if (!allPassed) {
    process.exit(1);
  }
}

main();
