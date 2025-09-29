# WHP Codes

Automatically extract popup promo codes from Whop product pages.

## Purpose

This tool scans Whop product pages and extracts popup promo codes when present, automating the manual process of checking DevTools network responses for `popupPromoCode` data.

## Installation

```bash
npm i
npm run install:browsers
```

## Usage

### Option 1: Use whpcodes.com Index (Recommended)

Use whpcodes.com as a comprehensive product index to discover and scrape all listed Whop products:

```bash
npm run scrape:whpcodes
```

This will:
1. Auto-detect whpcodes.com pagination scheme (/?page=N or /page/N)
2. Iterate through all pages to collect "Go to page" links
3. Visit each Whop product page to capture popup promo codes
4. Save results to both JSON and CSV formats

**Advantages:**
- Comprehensive coverage (hundreds of products vs. limited category discovery)
- Deterministic pagination (no button-clicking failures)
- Pre-filtered to active/popular products

### Option 2: Crawl Everything

Automatically discover and scrape all products across major Whop categories:

```bash
npm run scrape:all
```

### Option 3: Using a URL list

1. Add product URLs to `product_urls.txt` (one URL per line):
```
https://whop.com/discover/ftg-trading/?productId=prod_mfkskKNw7lb9m...
https://whop.com/discover/another-product/?productId=prod_xyz123...
```

2. Run the scraper:
```bash
npm run scrape
```

### Option 4: Using a seed URL to discover products

```bash
npm run scrape:seed
# or set a custom seed URL:
WHOP_START_URL=https://whop.com/discover/your-category/ npm run scrape
```

### Optional: Authentication

Some promo codes are only visible when logged in. To use your authentication:

1. Export cookies from your logged-in browser session
2. Save them as `cookies.json` (see `cookies.example.json` for format)
3. The scraper will automatically load them

## Configuration

### Environment Variables

**For all modes:**
- `WHOP_CONCURRENCY`: Number of concurrent scrapers (default: 2)
- `WHOP_COOKIES`: Path to cookies file (default: `./cookies.json`)
- `HEADLESS`: Set to `false` to run in visible browser mode (default: `true`)

**For URL list mode:**
- `WHOP_URL_LIST`: Path to URL list file (default: `./product_urls.txt`)

**For seed discovery mode:**
- `WHOP_START_URL`: Category/search URL to discover product links from

**For crawl everything mode:**
- `WHOP_MAX_PAGES`: Max pages to crawl per category (default: 50)

**For whpcodes.com mode:**
- `WHPCODES_MAX_PAGES`: Max pages to crawl on whpcodes.com (default: 200)
- `WHPCODES_START_URL`: Custom whpcodes.com URL (default: https://whpcodes.com/)
- `WHOP_DELAY_MS`: Delay between product visits in ms (default: 250)

### Examples

```bash
# Run whpcodes scraper in visible browser mode
HEADLESS=false npm run scrape:whpcodes

# Lower concurrency for safety
WHOP_CONCURRENCY=1 npm run scrape:whpcodes

# Limit whpcodes pagination
WHPCODES_MAX_PAGES=50 npm run scrape:whpcodes

# More polite delays
WHOP_DELAY_MS=500 npm run scrape:whpcodes

# Run in visible browser mode
HEADLESS=false npm run scrape:all

# Lower concurrency for safety
WHOP_CONCURRENCY=1 npm run scrape:all

# Limit category pagination
WHOP_MAX_PAGES=10 npm run scrape:all
```

## Output

Results are saved to:
- `out/whop_popup_codes.json`: Array of records in JSON format
- `out/whop_popup_codes.csv`: CSV with columns: timestamp, productUrl, productId, productRoute, productTitle, amountOff, discountOff, code, promoId

## Legal & Ethical Use

⚠️ **Important**: Only run this tool on pages you're authorized to crawl. Respect the website's terms of service and avoid generating excessive load on their servers. This tool is designed for research and personal use only.

## How It Works

For each URL, the scraper:
1. Loads the page
2. Reloads once (to mirror manual refresh behavior)
3. Captures all network responses during the page lifecycle
4. Finds responses containing "popupPromoCode"
5. Extracts the latest matching response (equivalent to "bottom result" in DevTools)
6. Parses both JSON payloads and React Server Component streams
7. Saves extracted promo code data