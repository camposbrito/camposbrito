#!/usr/bin/env node
/**
 * Multi-Model Orchestrator - Real Test Harness Builder & Verifier (Fase 2)
 *
 * Objetivo:
 *  Impedir que modelos de IA criem "mocks teatrais" (fazer mock do banco ou do próprio service).
 *  Este script:
 *   1. (--init) Gera um template de Test Harness Real (`tests/harness/real-harness.js`) no projeto-alvo,
 *      com servidor HTTP em porta efêmera real, banco de dados de teste real e bloqueio ativo contra mocks de DB.
 *   2. (--verify) Roda um verificador de integridade nos testes existentes + executa a suíte real.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const getArg = (flag, def = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const targetPath = path.resolve(getArg('--path', process.cwd()));
const isInit = args.includes('--init');
const isVerify = args.includes('--verify') || !isInit;

const HARNESS_TEMPLATE = `/**
 * 🏗️ REAL TEST HARNESS (Fase 2 - Anti-Reward-Hacking)
 * Gerado pela skill global: multi-model-orchestrator
 *
 * REGRAS INVIOLÁVEIS DESTE HARNESS:
 *  1. PROIBIDO mockar banco de dados, repositórios ou o próprio caso de uso testado.
 *  2. O servidor sobe em porta efêmera real (127.0.0.1:0) e executa queries reais.
 *  3. Cada teste roda em isolamento transacional ou banco temporário real.
 */

const http = require('http');

// 🛡️ Guardião Anti-Malandragem: Bloqueia tentativas de mockar módulos internos críticos
function enforceZeroInternalMocks(forbiddenPatterns = [/repository/i, /database/i, /prisma/i, /knex/i, /sequelize/i, /db/i]) {
  const checkMockTarget = (moduleName) => {
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(moduleName)) {
        throw new Error(
          \`[HARNESS VIOLATION] Tentativa ilegal de criar mock para módulo crítico ("\${moduleName}"). \` +
          \`Use o banco de teste real do Harness em vez de mocks falsos!\`
        );
      }
    }
  };

  if (global.jest && typeof global.jest.mock === 'function') {
    const origMock = global.jest.mock.bind(global.jest);
    global.jest.mock = (moduleName, ...rest) => {
      checkMockTarget(String(moduleName));
      return origMock(moduleName, ...rest);
    };
  }
}

/**
 * Inicializa um servidor HTTP real (Express/Fastify/Node http.Server) em porta efêmera
 * para testes de integração reais ponta a ponta.
 */
async function startRealServer(appOrHandler) {
  enforceZeroInternalMocks();
  return new Promise((resolve, reject) => {
    const server = http.createServer(appOrHandler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const baseUrl = \`http://127.0.0.1:\${address.port}\`;
      resolve({
        server,
        baseUrl,
        port: address.port,
        request: async ( reqPath, options = {} ) => {
          const res = await fetch(\`\${baseUrl}\${reqPath}\`, {
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
            ...options
          });
          const text = await res.text();
          let body = text;
          try { body = JSON.parse(text); } catch {}
          return { status: res.status, headers: res.headers, body };
        },
        close: () => new Promise((resClose) => server.close(resClose))
      });
    });
    server.on('error', reject);
  });
}

module.exports = {
  enforceZeroInternalMocks,
  startRealServer
};
`;

function initHarness() {
  const harnessDir = path.join(targetPath, 'tests', 'harness');
  const harnessFile = path.join(harnessDir, 'real-harness.js');

  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(harnessFile, HARNESS_TEMPLATE, 'utf-8');
  console.log(`✅ [Harness Real Criado] Arquivo gerado em: ${harnessFile}`);
}

function scanTestFilesForFakeMocks(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanTestFilesForFakeMocks(fullPath, results);
    } else if (/\.(test|spec)\.(js|ts|jsx|tsx)$/.test(entry.name)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (/(jest|vi)\.mock\(['"].*(db|database|repository|prisma|knex|sql)/i.test(line)) {
          results.push({
            file: path.relative(targetPath, fullPath),
            line: idx + 1,
            type: 'FORBIDDEN_DB_MOCK',
            snippet: line.trim()
          });
        }
        if (/\b(it|test|describe)\.skip\s*\(/.test(line)) {
          results.push({
            file: path.relative(targetPath, fullPath),
            line: idx + 1,
            type: 'SKIPPED_TEST',
            snippet: line.trim()
          });
        }
      });
    }
  }
  return results;
}

function verifyHarness() {
  console.log(`🏗️ [Fase 2 - Verificador de Test Harness Real] Inspecionando: ${targetPath}`);
  const violations = scanTestFilesForFakeMocks(targetPath);

  if (violations.length > 0) {
    console.warn(`\n🚨 Encontrado(s) ${violations.length} desvio(s) de Harness Real nos arquivos de teste:`);
    for (const v of violations) {
      console.warn(`  - [${v.type}] ${v.file}:${v.line} -> ${v.snippet}`);
    }
  } else {
    console.log('✅ Nenhum mock ilegal de banco/repositório ou teste pulado (.skip) detectado.');
  }

  const pkgPath = path.join(targetPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
        console.log('\n🧪 Executando suíte de testes do projeto...');
        execSync('npm test', { cwd: targetPath, stdio: 'inherit' });
      }
    } catch (err) {
      console.error('❌ Falha na execução da suíte de testes real.');
      process.exit(1);
    }
  }
}

if (isInit) {
  initHarness();
}
if (isVerify) {
  verifyHarness();
}
