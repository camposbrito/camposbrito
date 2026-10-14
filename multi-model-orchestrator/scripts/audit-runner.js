#!/usr/bin/env node
/**
 * Multi-Model Orchestrator - Clinical Audit & Infra Runner
 * (3-Tier Cascade: 1º AGY Native CLI -> 2º OpenCode OpenRouter -> 3º OpenCode Free / AGY Flash)
 *
 * Modelos Nativos do AGY (`agy models`):
 *  - claude-opus-5-5-high | claude-opus-5-5-medium | claude-opus-5-5-low
 *  - claude-sonnet-5-5-high | claude-sonnet-5-5-medium | claude-sonnet-5-5-low
 *  - gpt-oss-120b-medium
 *  - gemini-3.8-flash-high | gemini-3.8-flash-medium | gemini-3.8-flash-low
 *  - gemini-4-argon-high | gemini-4-argon-medium | gemini-4-argon-low
 */

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const homeDir = os.homedir();
process.env.PATH = `${path.join(homeDir, '.local', 'bin')}:${path.join(homeDir, '.opencode', 'bin')}:${process.env.PATH || ''}`;

const AGY_MODEL_MAP = {
  'claude-opus': 'claude-opus-5-5-high',
  'claude-sonnet': 'claude-sonnet-5-5-high',
  'gpt-oss': 'gpt-oss-120b-medium',
  'flash': 'gemini-3.8-flash-high',
  'argon': 'gemini-4-argon-high'
};

const OPENCODE_MODEL_MAP = {
  'claude-opus': 'openrouter/anthropic/claude-opus-5.5',
  'claude-sonnet': 'openrouter/anthropic/claude-sonnet-5.5',
  'deepseek': 'openrouter/deepseek/deepseek-v4-pro',
  'deepseek-r1': 'openrouter/deepseek/deepseek-r1',
  'gpt-oss': 'openrouter/openai/gpt-oss-120b',
  'free': 'opencode/nemotron-3-ultra-free'
};

const args = process.argv.slice(2);
const getArg = (flag, def = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const mode = getArg('--mode', 'audit'); // 'audit' | 'infra' | 'local-infra'
const targetPath = path.resolve(getArg('--path', process.cwd()));
const customPrompt = getArg('--prompt', '');
const rawModel = getArg('--model', mode === 'audit' ? 'claude-sonnet' : 'gpt-oss');

const CLINICAL_AUDIT_PROMPT = `O Gemini gerou esse código e essa suíte de testes. Não aceite nada pelo valor de face.
Atue como Auditor Clínico DevSecOps implacável (Claude 5.5 Core Reviewer):
1. Procure atalhos técnicos malsucedidos (catch vazio, @ts-ignore, any, TODOs esquecidos).
2. Cace mocks falsos que mascaram problemas de runtime ou testes que apenas retornam true sem testar a integração real.
3. Identifique brechas de segurança no SQL (SQL Injection), falhas de autenticação/autorização e exposição de segredos.
4. Identifique falhas de concorrência (race conditions), falta de transações atômicas e vazamentos de recursos.
Seja extremamente criterioso e liste Arquivo, Linha, Severidade (CRÍTICA/ALTA/MÉDIA) e Correção Obrigatória.`;

function checkStaticSmells(diffText) {
  const findings = [];
  const lines = diffText.split('\n');
  let currentFile = 'unknown';

  const rules = [
    {
      id: 'EMPTY_CATCH',
      severity: 'ALTA',
      regex: /^\+.*catch\s*\([^)]*\)\s*\{\s*\}/,
      desc: 'Bloco catch vazio detectado (engolindo exceções silenciosamente).'
    },
    {
      id: 'TS_IGNORE_OR_ANY',
      severity: 'MÉDIA',
      regex: /^\+.*(@ts-ignore|@ts-nocheck|:\s*any\b|eslint-disable)/,
      desc: 'Supressão de tipo/linter detectada (@ts-ignore / any / eslint-disable).'
    },
    {
      id: 'SKIPPED_TEST',
      severity: 'CRÍTICA',
      regex: /^\+.*\b(it\.skip|test\.skip|describe\.skip|xit|xdescribe)\b/,
      desc: 'Teste desativado (.skip / xit) para forçar suíte verde.'
    },
    {
      id: 'WEAK_ASSERTION_OR_FAKE_MOCK',
      severity: 'ALTA',
      regex: /^\+.*(mockResolvedValue\(\{\s*success:\s*true\s*\}\)|expect\(true\)\.toBe\(true\))/,
      desc: 'Suspeita de mock teatral ou asserção tautológica (reward hacking).'
    },
    {
      id: 'RAW_SQL_INTERPOLATION',
      severity: 'CRÍTICA',
      regex: /^\+.*(SELECT|INSERT|UPDATE|DELETE)\b.*\$\{/i,
      desc: 'Interpolação direta de string em query SQL (risco crítico de SQL Injection).'
    }
  ];

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.replace('+++ b/', '').trim();
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    for (const rule of rules) {
      if (rule.regex.test(line)) {
        findings.push({
          file: currentFile,
          severity: rule.severity,
          id: rule.id,
          desc: rule.desc,
          snippet: line.substring(1).trim().slice(0, 120)
        });
      }
    }
  }
  return findings;
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', env: process.env });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cascata de 3 Níveis:
 *  Nível 1: AGY CLI Nativo (`agy --model claude-sonnet-5-5-high` / `claude-opus-5-5-high` / `gpt-oss-120b-medium`)
 *  Nível 2: OpenCode + OpenRouter Pago (`openrouter/anthropic/claude-sonnet-5.5` / `deepseek-v4-pro`)
 *  Nível 3: OpenCode Free (`opencode/nemotron-3-ultra-free`)
 */
function executeWithCascade(promptText, modelAlias) {
  const agyModel = AGY_MODEL_MAP[modelAlias] || (modelAlias.startsWith('claude-') || modelAlias.startsWith('gpt-oss') || modelAlias.startsWith('gemini-') ? modelAlias : null);
  const openCodeModel = OPENCODE_MODEL_MAP[modelAlias] || modelAlias;

  // 1. Tenta primeiro no AGY Nativo (usa a própria assinatura do Antigravity!)
  if (agyModel && commandExists('agy')) {
    console.log(`🌟 [Nível 1 - AGY Nativo] Invocando 'agy --model ${agyModel}'...`);
    const agyRes = spawnSync('agy', ['--model', agyModel, '--disable-slash-commands', '-p', promptText], {
      cwd: targetPath,
      encoding: 'utf-8',
      env: process.env
    });

    const agyOut = `${agyRes.stdout || ''}\n${agyRes.stderr || ''}`;
    if (agyRes.status === 0 && !/RESOURCE_EXHAUSTED|quota reached/i.test(agyOut)) {
      if (agyRes.stdout) console.log(agyRes.stdout);
      return 0;
    }

    const resetMatch = agyOut.match(/Resets in [0-9hms]+/i);
    console.warn(
      `⚠️ [AGY Nativo] Cota temporariamente atingida para '${agyModel}'${resetMatch ? ` (${resetMatch[0]})` : ''}. ` +
      `Acionando Nível 2 (OpenCode + OpenRouter)...`
    );
  }

  // 2. Nível 2: OpenCode Agent Harness + OpenRouter
  if (commandExists('opencode')) {
    const ocAgent = mode === 'audit' ? 'clinical-auditor' : 'infra-specialist';
    console.log(`🚀 [Nível 2 - OpenCode Harness (${ocAgent})] Invocando 'opencode run --agent ${ocAgent} -m ${openCodeModel}'...`);
    const ocRes = spawnSync('opencode', ['run', '--agent', ocAgent, '-m', openCodeModel, '--thinking', promptText], {
      cwd: targetPath,
      encoding: 'utf-8',
      env: process.env
    });

    const ocOut = `${ocRes.stdout || ''}\n${ocRes.stderr || ''}`;
    const isCreditError = /402|insufficient|credit|balance|payment/i.test(ocOut);

    if (ocRes.status === 0 && !isCreditError) {
      if (ocRes.stdout) console.log(ocRes.stdout);
      return 0;
    }

    // 3. Nível 3: Fallback Gratuito Imediato dentro do mesmo Agent Harness
    if (openCodeModel !== OPENCODE_MODEL_MAP.free) {
      console.warn(`⚠️ [OpenCode Harness] Modelo '${openCodeModel}' sem saldo pré-pago no momento. Acionando Nível 3 (${OPENCODE_MODEL_MAP.free} no agente ${ocAgent})...`);
      const freeRes = spawnSync('opencode', ['run', '--agent', ocAgent, '-m', OPENCODE_MODEL_MAP.free, promptText], {
        cwd: targetPath,
        encoding: 'utf-8',
        env: process.env
      });
      if (freeRes.stdout) console.log(freeRes.stdout);
      if (freeRes.stderr) console.error(freeRes.stderr);
      return freeRes.status;
    }
  }

  console.error('❌ Nenhum motor disponível conseguiu concluir a requisição.');
  return 1;
}

function runAudit() {
  console.log('🕵️‍♂️ [Fase 3 - Auditor Clínico DevSecOps] Iniciando inspeção em:', targetPath);

  let diff = '';
  try {
    diff = execSync('git diff HEAD 2>/dev/null', { cwd: targetPath, maxBuffer: 10 * 1024 * 1024 }).toString();
    if (!diff.trim()) {
      diff = execSync('git diff HEAD~1..HEAD 2>/dev/null', { cwd: targetPath, maxBuffer: 10 * 1024 * 1024 }).toString();
    }
  } catch (err) {
    console.warn('⚠️ Diretório atual não possui histórico git ativo para extrair diff automático.');
  }

  const smells = diff ? checkStaticSmells(diff) : [];
  console.log(`\n📊 Scanner Anti-Malandragem Preliminar: ${smells.length} alerta(s) encontrado(s).`);
  for (const s of smells) {
    console.log(`  - [${s.severity}] (${s.id}) em ${s.file}: ${s.desc}`);
    console.log(`    Código: ${s.snippet}`);
  }

  if (args.includes('--dry-run')) {
    console.log('✅ [Dry-Run] Cascata de 3 níveis pronta: 1º AGY CLI Nativo -> 2º OpenCode OpenRouter -> 3º OpenCode Free.');
    return;
  }

  const payload = diff.trim()
    ? `${CLINICAL_AUDIT_PROMPT}\n\nGit Diff:\n${diff.slice(0, 45000)}`
    : `${CLINICAL_AUDIT_PROMPT}\n\nNenhum git diff pendente encontrado em ${targetPath}. Responda em 1 linha confirmando que o motor de Auditoria Clínica está online.`;

  executeWithCascade(payload, rawModel);
}

function runInfra() {
  console.log(`📦 [Pilar Infra / GPT-OSS / DeepSeek - ${rawModel}] Executando tarefa...`);
  if (!customPrompt) {
    console.error('Erro: informe --prompt "Sua instrução de infraestrutura/Docker"');
    process.exit(1);
  }
  const status = executeWithCascade(customPrompt, rawModel);
  process.exit(status || 0);
}

if (mode === 'infra' || mode === 'local-infra') {
  runInfra();
} else {
  runAudit();
}
