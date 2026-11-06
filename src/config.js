require('dotenv').config();
const crypto = require('crypto');

// QODER_CLI selects which Qoder CLI flavour the proxy drives:
//   "global" → qodercli      (qoder.com, international)
//   "cn"     → qoderclicn    (qoder.com.cn, China)
// Case-insensitive; unset/invalid falls back to "global" so existing
// deployments keep the exact behaviour they had before this option existed.
const QODER_CLI = (() => {
  const raw = (process.env.QODER_CLI || '').trim().toLowerCase();
  if (raw === '') return 'global';
  if (raw === 'cn' || raw === 'global') return raw;
  console.warn(
    `[config] Invalid QODER_CLI "${process.env.QODER_CLI}" — expected "cn" or "global", falling back to "global"`,
  );
  return 'global';
})();

// Mode-aware resolved PAT (the value handed to the CLI child process):
//   cn:     QODERCN_PERSONAL_ACCESS_TOKEN > QODER_PERSONAL_ACCESS_TOKEN > QODER_API_KEY
//   global: QODER_PERSONAL_ACCESS_TOKEN > QODER_API_KEY   (unchanged legacy order)
const QODER_ACTIVE_PAT = QODER_CLI === 'cn'
  ? (process.env.QODERCN_PERSONAL_ACCESS_TOKEN ||
     process.env.QODER_PERSONAL_ACCESS_TOKEN ||
     process.env.QODER_API_KEY ||
     null)
  : (process.env.QODER_PERSONAL_ACCESS_TOKEN ||
     process.env.QODER_API_KEY ||
     null);

module.exports = {
  PORT:              parseInt(process.env.PORT) || 3000,
  API_KEY:           process.env.PROXY_API_KEY || null,
  CORS_ORIGIN:       process.env.CORS_ORIGIN || '*',
  QODER_TIMEOUT_MS:  parseInt(process.env.QODER_TIMEOUT_MS) || 120_000,
  QODER_MAX_OUTPUT_TOKENS: (() => {
    const v = (process.env.QODER_MAX_OUTPUT_TOKENS || '').trim().toLowerCase();
    return v === '16k' || v === '32k' ? v : '16k';
  })(),
  QODER_PAT:         process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_API_KEY || null,
  // Mode-aware values (see derivation above). QODER_PAT stays as the legacy
  // global-order field so older consumers keep working unchanged.
  QODER_CLI,
  QODER_ACTIVE_PAT,
  PUBLIC_BASE_URL:   process.env.PUBLIC_BASE_URL || null,

  // Dashboard
  DASHBOARD_ENABLED:  process.env.DASHBOARD_ENABLED !== 'false',
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || null,
  DASHBOARD_SECRET:   process.env.DASHBOARD_SECRET   || crypto.randomBytes(32).toString('hex'),

  // Logging
  LOG_MAX_ENTRIES:   parseInt(process.env.LOG_MAX_ENTRIES)   || 500,
  LOG_BODY_MAX_BYTES:parseInt(process.env.LOG_BODY_MAX_BYTES) || 8192,
};
