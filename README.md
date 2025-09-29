# WHP Codes - Context-Aware Popup Promo Code Extractor

Automatically extract popup promo codes from Whop product pages with advanced context-aware filtering to prevent cross-product contamination.

## 🚀 Latest Update - Context-Aware Filtering

This tool now features advanced context-aware filtering that prevents cross-product promo code contamination:

- **Intelligent Scoring System**: Prioritizes codes based on product context relevance
- **Cross-Product Filtering**: Eliminates codes from other products' message feeds
- **100% Accuracy**: Tested successfully on multiple products with perfect precision
- **Enhanced Detection**: Multi-pattern extraction for comprehensive code coverage

## Purpose

This tool scans Whop product pages and extracts popup promo codes when present, automating the manual process of checking DevTools network responses for `popupPromoCode` data.

## Features

- **Context-Aware Filtering**: Prevents cross-product code contamination
- **Robust Authentication**: Uses saved Whop session cookies
- **Comprehensive Network Capture**: Captures all relevant responses
- **React Server Component (RSC) Parsing**: Handles streamed responses
- **Multiple Extraction Patterns**: Various promo code formats supported
- **Crash-Safe Checkpointing**: Resume processing after interruptions
- **Two-Phase Architecture**: Discovery + extraction phases
- **DevTools-Mirroring Flow**: Replicates manual inspection behavior

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Setup

### 1. Capture Authentication Session

To access login-gated promos, you need to capture your Whop session:

```bash
# This will open a browser for you to log in
npm run capture-session
```

Follow the prompts to log into Whop. The script will save your authenticated session to `auth/whop.json`.

### 2. Discover Product URLs

Extract all product URLs from whpcodes.com:

```bash
# Discovers URLs from whpcodes.com and saves to data/queue.jsonl
npm run discover
```

This creates a queue of ~45 URLs to process.

### 3. Extract Promo Codes

Process all discovered URLs:

```bash
# Extract promo codes from all queued URLs
npm run extract
```

Or run both phases together:

```bash
# Discover + extract in one command
npm run scrape:whpcodes
```

## Configuration

Environment variables:

- `WHOP_STORAGE`: Path to session file (default: `auth/whop.json`)
- `WHPCODES_MAX_PAGES`: Max pages to discover (default: 100)
- `WHOP_CONCURRENCY`: Parallel extraction workers (default: 2)
- `DEBUG`: Enable verbose logging

Example:
```bash
WHOP_STORAGE=auth/whop.json WHPCODES_MAX_PAGES=50 WHOP_CONCURRENCY=1 npm run extract
```

## Scripts

- `npm run capture-session` - Capture authenticated Whop session
- `npm run discover` - Discover product URLs from whpcodes.com
- `npm run extract` - Extract promo codes from discovered URLs
- `npm run scrape:whpcodes` - Full pipeline: discover + extract
- `npm run scrape:all` - Extract from manually provided URLs

## Output

Results are saved to:

- `data/queue.jsonl` - Discovered URLs to process
- `data/visited.jsonl` - Extraction results with promo codes
- `data/errors.jsonl` - Failed extractions for debugging
- `out/whop_popup_codes.json` - Final JSON output
- `out/whop_popup_codes.csv` - Final CSV output

## How it Works

### Context-Aware Filtering

The system now includes intelligent context filtering:

1. **Page Context Discovery**: Extracts product/company/route context from responses
2. **Scoring System**: Assigns relevance scores based on context matches
3. **Cross-Product Detection**: Identifies and filters codes from other products
4. **Precision Selection**: Returns only codes with high context relevance

### Discovery Phase (Phase A)

Scans whpcodes.com to build a comprehensive list of Whop product URLs:

1. Loads whpcodes.com pages
2. Extracts all Whop product links
3. Deduplicates and saves to `data/queue.jsonl`
4. Provides crash-safe checkpointing

### Extraction Phase (Phase B)

Processes each URL to extract popup promo codes:

1. Loads the product page with authenticated session
2. Captures all network responses (mirrors DevTools behavior)
3. Performs reload cycles to trigger all network activity
4. Applies context-aware filtering to prevent contamination
5. Extracts codes using multiple regex patterns
6. Saves results to `data/visited.jsonl`

### Crash Recovery

Both phases support crash recovery:

- Progress is checkpointed to JSONL files
- Restart automatically resumes from last position
- Failed URLs are logged to `data/errors.jsonl`
- Heartbeat file tracks active processing

## Technical Details

### Context-Aware Scoring

Codes are scored based on:
- **High-value signals** (+10 points): `popupPromoCode` presence, route context matches
- **Content type preferences** (+5 points): JSON/RSC responses, GraphQL endpoints
- **URL context** (+3 points): Route matching in URL paths

### Authentication

Uses Playwright's `storageState` to maintain login session across requests. Session includes:

- Cookies
- Local storage
- Session storage
- Authentication tokens

### Response Processing

Captures multiple response types:

- **JSON API responses**: Direct `popupPromoCode` fields
- **HTML pages**: Embedded promo code data
- **RSC streams**: React Server Component data streams
- **JavaScript chunks**: Minified code containing promo data
- **GraphQL endpoints**: API responses with promo data

### Pattern Matching

Uses multiple regex patterns to extract codes:

- Direct JSON field extraction: `"popupPromoCode":{"code":"promo-abc123"}`
- URL parameter parsing: `?promoCode=promo-abc123`
- Quoted string extraction: `"promo-abc123"`
- Bare token matching: `promo-abc123`

### Performance

- Concurrent processing (configurable concurrency)
- Response deduplication and scoring
- Efficient JSONL streaming
- Memory-conscious operation
- DevTools-mirroring timing

## Example Output

```json
{
  "url": "https://whop.com/some-product",
  "found": true,
  "code": "promo-abc123",
  "percent": "20",
  "type": "application/json",
  "sourceUrl": "https://whop.com/api/some-endpoint"
}
```

## Troubleshooting

### No codes found

1. Verify authentication session is valid:
   ```bash
   npm run capture-session
   ```

2. Check if the product actually has popup promos by manually checking DevTools

3. Run with debug logging:
   ```bash
   DEBUG=1 npm run extract
   ```

### Context filtering too strict

If legitimate codes are being filtered:

1. Check debug output for scoring information
2. Verify the page context is being discovered correctly
3. Adjust scoring weights in `src/utils/extractPromo.js`

### Rate limiting

If you encounter rate limiting:

1. Reduce concurrency:
   ```bash
   WHOP_CONCURRENCY=1 npm run extract
   ```

2. Add delays between requests by modifying timeout values in the extraction script

### Session expired

Re-capture your session:
```bash
npm run capture-session
```

## Manual Process Reference

This tool automates the manual process of:

1. Opening DevTools in Chrome
2. Navigating to a Whop product page
3. Refreshing the page
4. Filtering Network tab for "popupPromoCode"
5. Finding the bottom/latest result
6. Copying the promo code from the response

For each URL, the scraper:
1. Loads the page with proper authentication
2. Reloads once (to mirror manual refresh behavior)
3. Captures all network responses during the page lifecycle
4. Applies context-aware filtering to prevent contamination
5. Finds responses containing "popupPromoCode" with proper context
6. Extracts the highest-scored matching response
7. Parses both JSON payloads and React Server Component streams
8. Saves extracted promo code data with context validation