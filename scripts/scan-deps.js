#!/usr/bin/env node
/**
 * GrocerSnap — Dependency Security Scanner
 * Runs on every npm install / CI pipeline
 *
 * Checks:
 *  1. npm audit — known CVEs in installed packages
 *  2. Suspicious package names (typosquatting patterns)
 *  3. New packages added since last scan (diff check)
 *  4. Packages with install scripts (supply chain risk)
 *
 * Usage:
 *   node scripts/scan-deps.js          — full scan
 *   node scripts/scan-deps.js --quick  — audit only
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = path.join(__dirname, '..', '.dep-snapshot.json');
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

let passed = 0;
let warnings = 0;
let failures = 0;

function pass(msg)  { console.log(`  ${GREEN}✅ PASS${RESET}  ${msg}`); passed++;   }
function warn(msg)  { console.log(`  ${YELLOW}⚠️  WARN${RESET}  ${msg}`); warnings++; }
function fail(msg)  { console.log(`  ${RED}❌ FAIL${RESET}  ${msg}`); failures++;  }

console.log(`\n${BOLD}🔍 GrocerSnap Dependency Security Scanner${RESET}`);
console.log('─'.repeat(50));

// ── 1. npm audit ─────────────────────────────────────────────────────────────
console.log(`\n${BOLD}[1/4] npm audit (CVE check)${RESET}`);
try {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const audit = execSync(`${npmCmd} audit --json`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const result = JSON.parse(audit);
  const vulns = result.metadata?.vulnerabilities || {};
  const critical = vulns.critical || 0;
  const high     = vulns.high     || 0;
  const moderate = vulns.moderate || 0;
  const low      = vulns.low      || 0;

  if (critical > 0) fail(`${critical} CRITICAL vulnerabilities found — run: npm audit fix`);
  else pass('No critical vulnerabilities');

  if (high > 0) fail(`${high} HIGH vulnerabilities found — run: npm audit fix`);
  else pass('No high vulnerabilities');

  if (moderate > 0) warn(`${moderate} moderate vulnerabilities (review with: npm audit)`);
  else pass('No moderate vulnerabilities');

  if (low > 0) warn(`${low} low-severity issues (informational)`);

} catch (e) {
  warn('npm audit could not complete — check manually');
}

// ── 2. Typosquatting check ────────────────────────────────────────────────────
console.log(`\n${BOLD}[2/4] Typosquatting / suspicious name check${RESET}`);

const SUSPICIOUS_PATTERNS = [
  /^expresss$/i,    // express typo
  /^reqest$/i,      // request typo
  /^lodas[h]?$/i,   // lodash typo
  /^momnet$/i,      // moment typo
  /^axois$/i,       // axios typo
  /^reakt$/i,       // react typo
  /^dotennv$/i,     // dotenv typo
  /crossenv$/i,     // cross-env typo (was malware)
  /^event-source-polyfil$/i,
  /^node-imap2$/i,
  /^discord\.js$/i, // common confusion
];

try {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const allDeps = [
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
  ];

  let suspiciousFound = false;
  for (const dep of allDeps) {
    if (SUSPICIOUS_PATTERNS.some(p => p.test(dep))) {
      fail(`Suspicious package name: "${dep}" — verify this is the correct package`);
      suspiciousFound = true;
    }
  }
  if (!suspiciousFound) pass(`${allDeps.length} packages checked — no suspicious names`);
} catch (e) {
  warn('Could not read package.json for typosquatting check');
}

// ── 3. New package detection (diff from last scan) ───────────────────────────
console.log(`\n${BOLD}[3/4] New packages since last scan${RESET}`);

try {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const currentDeps = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
  ]);

  if (fs.existsSync(SNAPSHOT_FILE)) {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    const prevDeps = new Set(snapshot.packages || []);
    const newPkgs = [...currentDeps].filter(d => !prevDeps.has(d));
    const removedPkgs = [...prevDeps].filter(d => !currentDeps.has(d));

    if (newPkgs.length > 0) {
      warn(`${newPkgs.length} new package(s) added: ${newPkgs.join(', ')}`);
      warn('Review each new package at npmjs.com before deployment');
    } else {
      pass('No new packages since last scan');
    }
    if (removedPkgs.length > 0) {
      pass(`${removedPkgs.length} package(s) removed: ${removedPkgs.join(', ')}`);
    }
  } else {
    warn('No previous snapshot found — creating baseline now');
  }

  // Save new snapshot
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
    scannedAt: new Date().toISOString(),
    packages: [...currentDeps],
  }, null, 2));
  pass('Snapshot saved for next comparison');

} catch (e) {
  warn('Snapshot check failed — ' + e.message);
}

// ── 4. Install script detection (supply chain risk) ──────────────────────────
console.log(`\n${BOLD}[4/4] Install script detection (supply chain risk)${RESET}`);

try {
  const nodeModules = path.join(__dirname, '..', 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    warn('node_modules not found — run npm install first');
  } else {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const topDeps = Object.keys(pkgJson.dependencies || {});
    const risky = [];

    for (const dep of topDeps) {
      const depPkg = path.join(nodeModules, dep, 'package.json');
      if (!fs.existsSync(depPkg)) continue;
      const d = JSON.parse(fs.readFileSync(depPkg, 'utf8'));
      const scripts = d.scripts || {};
      if (scripts.preinstall || scripts.postinstall || scripts.install) {
        risky.push(`${dep} (has ${[scripts.preinstall && 'preinstall', scripts.install && 'install', scripts.postinstall && 'postinstall'].filter(Boolean).join(',')} script)`);
      }
    }

    if (risky.length > 0) {
      warn(`${risky.length} package(s) run scripts on install — verify these are expected:`);
      risky.forEach(r => console.log(`     • ${r}`));
    } else {
      pass('No unexpected install scripts found');
    }
  }
} catch (e) {
  warn('Install script check failed — ' + e.message);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`${BOLD}Scan complete:${RESET} ${GREEN}${passed} passed${RESET}  ${YELLOW}${warnings} warnings${RESET}  ${RED}${failures} failures${RESET}\n`);

if (failures > 0) {
  console.log(`${RED}${BOLD}ACTION REQUIRED: Fix failures before deploying.${RESET}\n`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`${YELLOW}Warnings present — review before deploying.${RESET}\n`);
  process.exit(0);
} else {
  console.log(`${GREEN}${BOLD}All clear — safe to deploy.${RESET}\n`);
  process.exit(0);
}
