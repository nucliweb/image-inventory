#!/usr/bin/env node

// index.js

import { program } from "commander";
import ImageScraper from "./imageScraper.js";

// Configure CLI options
program
  .name("web-image-analyzer")
  .description(
    "Analyze images on web pages with customizable depth and URL patterns",
  )
  .version("1.0.0")
  .requiredOption("-u, --url <url>", "URL to analyze")
  .option("-d, --depth <number>", "Maximum depth for crawling", "2")
  .option("-p, --pattern <pattern>", "URL pattern to match (e.g., /2024/)")
  .option("--delay <ms>", "Delay between requests in milliseconds", "500")
  .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
  .option(
    "--min-size <bytes>",
    "Minimum image size in bytes to analyze",
    "1024",
  )
  .option("-v, --verbose", "Show detailed output for each page");

program.parse();

const options = program.opts();

// Validate depth is a number
const depth = parseInt(options.depth);
if (isNaN(depth) || depth < 0) {
  console.error("Error: depth must be a positive number");
  process.exit(1);
}

// Validate URL
try {
  new URL(options.url);
} catch (error) {
  console.error("Error: Invalid URL provided");
  process.exit(1);
}

try {
  const scraper = new ImageScraper({
    baseUrl: options.url,
    maxDepth: depth,
    urlPattern: options.pattern,
    verbose: options.verbose,
    config: {
      REQUEST_DELAY: parseInt(options.delay),
      REQUEST_TIMEOUT: parseInt(options.timeout),
      MIN_IMAGE_SIZE: parseInt(options.minSize),
    },
  });

  await scraper.start();
} catch (error) {
  console.error("Error:", error.message);
  process.exit(1);
}
