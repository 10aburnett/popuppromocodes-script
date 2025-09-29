// scripts/materialize-positives.js
// Generate clean CSV/JSON outputs from visited.jsonl containing only successful finds

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIS = path.join(__dirname, '..', 'data', 'visited.jsonl');
const OUTJ = path.join(__dirname, '..', 'out', 'whop_popup_codes.json');
const OUTC = path.join(__dirname, '..', 'out', 'whop_popup_codes.csv');

function* iterateVisited(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      yield JSON.parse(line);
    } catch (e) {
      console.warn(`⚠️ Skipping malformed line: ${line.slice(0, 100)}...`);
    }
  }
}

function materializeOutputs() {
  console.log('📊 Materializing clean outputs from visited data...');

  if (!fs.existsSync(VIS)) {
    console.log(`❌ No visited data found at ${VIS}`);
    console.log('   Run Phase B extraction first: node src/phaseB_extract.js');
    return;
  }

  // Collect all successful finds
  const positives = [];
  const stats = { total: 0, found: 0, empty: 0 };

  for (const record of iterateVisited(VIS)) {
    stats.total++;

    if (record.found && (record.code || record.amountOff || record.discountOff)) {
      stats.found++;

      // Convert to clean format for output
      const cleaned = {
        timestamp: record.checkedAt,
        productUrl: record.url,
        productId: extractProductId(record.url),
        productRoute: extractProductRoute(record.url),
        productTitle: '', // Could be enhanced to store from extraction
        amountOff: record.amountOff || '',
        discountOff: record.discountOff || '',
        code: record.code || '',
        promoId: record.promoId || '',
        sourceUrl: record.sourceUrl || '',
        extractionType: record.type || ''
      };

      positives.push(cleaned);
    } else {
      stats.empty++;
    }
  }

  // Sort by timestamp (most recent first)
  positives.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(OUTJ), { recursive: true });

  // Write JSON output
  fs.writeFileSync(OUTJ, JSON.stringify(positives, null, 2));

  // Write CSV output
  const csvHeader = 'timestamp,productUrl,productId,productRoute,productTitle,amountOff,discountOff,code,promoId,sourceUrl,extractionType\n';
  const csvRows = positives.map(row => {
    const escapeCsv = (value) => {
      const str = String(value || '');
      return `"${str.replace(/"/g, '""')}"`;
    };

    return [
      escapeCsv(row.timestamp),
      escapeCsv(row.productUrl),
      escapeCsv(row.productId),
      escapeCsv(row.productRoute),
      escapeCsv(row.productTitle),
      escapeCsv(row.amountOff),
      escapeCsv(row.discountOff),
      escapeCsv(row.code),
      escapeCsv(row.promoId),
      escapeCsv(row.sourceUrl),
      escapeCsv(row.extractionType)
    ].join(',');
  }).join('\n');

  fs.writeFileSync(OUTC, csvHeader + csvRows);

  // Report results
  console.log(`\n✅ Materialization complete!`);
  console.log(`📊 Processing stats:`);
  console.log(`   - Total URLs processed: ${stats.total}`);
  console.log(`   - Popup codes found: ${stats.found}`);
  console.log(`   - No codes found: ${stats.empty}`);
  console.log(`   - Success rate: ${((stats.found / stats.total) * 100).toFixed(1)}%`);
  console.log(`\n📁 Output files:`);
  console.log(`   - JSON: ${OUTJ} (${positives.length} records)`);
  console.log(`   - CSV:  ${OUTC} (${positives.length} records)`);

  // Show sample of found codes
  if (positives.length > 0) {
    console.log(`\n🎫 Sample popup codes found:`);
    positives.slice(0, 5).forEach(p => {
      const display = p.code || `${p.amountOff || p.discountOff} discount`;
      console.log(`   - ${display} (${p.extractionType}) from ${p.productUrl}`);
    });
    if (positives.length > 5) {
      console.log(`   ... and ${positives.length - 5} more`);
    }
  }
}

function extractProductId(url) {
  try {
    const parsed = new URL(url);
    // Try productId parameter first
    const productId = parsed.searchParams.get('productId');
    if (productId) return productId;

    // Try to extract from path
    const pathMatch = parsed.pathname.match(/\/([^/?]+)\/?$/);
    return pathMatch ? pathMatch[1] : '';
  } catch {
    return '';
  }
}

function extractProductRoute(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// Run if called directly
if (process.argv[1] === __filename) {
  materializeOutputs();
}

export { materializeOutputs };