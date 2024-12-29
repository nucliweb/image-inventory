import fetch from "node-fetch";
import * as cheerio from "cheerio";
import imageSize from "image-size";
import { URL } from "url";
import { performance } from "perf_hooks";

// Constants for configuration
const CONFIG = {
  RETRY_ATTEMPTS: 3,
  REQUEST_TIMEOUT: 10000,
  REQUEST_DELAY: 500,
  MIN_IMAGE_SIZE: 1024, // 1KB
  TRACKING_DOMAINS: ["google-analytics.com", "doubleclick.net", "analytics"],
};

/**
 * Main class for handling web scraping and image analysis
 */
class ImageScraper {
  constructor({
    baseUrl,
    maxDepth = 2,
    urlPattern = null,
    config = {},
    verbose = false,
  }) {
    this.baseUrl = new URL(baseUrl);
    this.maxDepth = maxDepth;
    this.urlPattern = urlPattern || this.baseUrl.pathname;
    this.visitedUrls = new Set();
    this.results = new Map();
    this.verbose = verbose;

    // Merge default config with provided config
    this.config = {
      ...CONFIG,
      ...config,
    };
  }

  /**
   * Start the scraping process
   */
  async start() {
    console.log(`Starting analysis of ${this.baseUrl.href}`);
    const startTime = performance.now();

    try {
      await this.scrapePage(this.baseUrl.href, 0);
      // Clear the progress line
      process.stdout.write("\r" + " ".repeat(50) + "\r");
      this.printResults();
    } catch (error) {
      console.error("Error during scraping:", error);
    }

    const endTime = performance.now();
    console.log(
      `\nAnalysis completed in ${((endTime - startTime) / 1000).toFixed(2)}s`,
    );
  }

  /**
   * Scrape a single page and analyze its images
   */
  async scrapePage(url, depth) {
    if (depth > this.maxDepth || this.visitedUrls.has(url)) {
      return;
    }

    this.visitedUrls.add(url);
    process.stdout.write(`\rProcessing page ${this.visitedUrls.size}...`);

    try {
      const response = await this.fetchWithRetry(url);
      const html = await response.text();

      const $ = cheerio.load(html);

      if (this.verbose) {
        console.log(`\nProcessing ${url} (Depth: ${depth})`);
        console.log("Found elements:");
        console.log(`- img tags: ${$("img").length}`);
        console.log(`- picture sources: ${$("picture source").length}`);
        console.log(
          `- background images: ${$('[style*="background"]').length}`,
        );
        console.log(`- links: ${$("a").length}\n`);
      }

      // Process images
      const images = await this.analyzeImages($, url);
      this.results.set(url, images);

      // Find and process links if not at max depth
      if (depth < this.maxDepth) {
        await this.processLinks($, url, depth);
      }
    } catch (error) {
      if (this.verbose) {
        console.error(`\nError processing ${url}:`, error.message);
      }
    }
  }

  /**
   * Analyze all images on a page
   */
  async analyzeImages($, baseUrl) {
    const images = [];
    const promises = [];

    // Process <img> tags
    $("img").each((_, element) => {
      const src = $(element).attr("src");
      if (src) {
        promises.push(this.processImage(src, baseUrl));
      }
    });

    // Process <picture> elements
    $("picture source").each((_, element) => {
      const srcset = $(element).attr("srcset");
      if (srcset) {
        const sources = srcset
          .split(",")
          .map((src) => src.trim().split(" ")[0]);
        promises.push(...sources.map((src) => this.processImage(src, baseUrl)));
      }
    });

    // Process CSS background images
    $('[style*="background"]').each((_, element) => {
      const style = $(element).attr("style");
      const match = style.match(/url\(['"]?([^'"())]+)['"]?\)/);
      if (match) {
        promises.push(this.processImage(match[1], baseUrl));
      }
    });

    const results = await Promise.allSettled(promises);
    return results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
  }

  /**
   * Process a single image
   */
  async processImage(src, baseUrl) {
    try {
      const imageUrl = new URL(src, baseUrl);

      // Skip tracking pixels
      if (this.isTrackingImage(imageUrl)) {
        return null;
      }

      const response = await this.fetchWithRetry(imageUrl.href);
      const buffer = await response.buffer();

      // Skip small images
      if (buffer.length < CONFIG.MIN_IMAGE_SIZE) {
        return null;
      }

      const dimensions = imageSize(buffer);

      return {
        url: imageUrl.href,
        size: buffer.length,
        width: dimensions.width,
        height: dimensions.height,
        type: dimensions.type,
      };
    } catch (error) {
      console.error(`Error processing image ${src}:`, error.message);
      return null;
    }
  }

  /**
   * Process all links on a page
   */
  async processLinks($, baseUrl, depth) {
    const links = new Set();

    $("a").each((_, element) => {
      const href = $(element).attr("href");
      if (href) {
        try {
          const url = new URL(href, baseUrl);
          if (this.shouldProcessUrl(url)) {
            links.add(url.href);
          }
        } catch (error) {
          console.error(`Invalid URL ${href}:`, error.message);
        }
      }
    });

    for (const link of links) {
      await this.delay(CONFIG.REQUEST_DELAY);
      await this.scrapePage(link, depth + 1);
    }
  }

  /**
   * Check if URL should be processed based on pattern
   */
  shouldProcessUrl(url) {
    // Remove hash from URL before comparing
    const urlWithoutHash = new URL(url);
    urlWithoutHash.hash = "";

    // Convert to string for comparison
    const urlString = urlWithoutHash.toString();

    // Check if we've already processed this URL (ignoring hash)
    if (
      Array.from(this.visitedUrls).some((visited) => {
        const visitedUrl = new URL(visited);
        visitedUrl.hash = "";
        return visitedUrl.toString() === urlString;
      })
    ) {
      return false;
    }

    return (
      url.hostname === this.baseUrl.hostname &&
      url.pathname.startsWith(this.urlPattern)
    );
  }

  /**
   * Check if image is from a tracking domain
   */
  isTrackingImage(url) {
    return CONFIG.TRACKING_DOMAINS.some(
      (domain) =>
        url.hostname.includes(domain) || url.pathname.includes(domain),
    );
  }

  /**
   * Fetch with retry logic
   */
  async fetchWithRetry(url, attempt = 1) {
    try {
      const response = await fetch(url, {
        timeout: this.config.REQUEST_TIMEOUT,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return response;
    } catch (error) {
      if (attempt < this.config.RETRY_ATTEMPTS) {
        console.log(
          `Retrying ${url} (Attempt ${attempt + 1}/${
            this.config.RETRY_ATTEMPTS
          })`,
        );
        await this.delay(this.config.REQUEST_DELAY * attempt);
        return this.fetchWithRetry(url, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Print results to console
   */
  printResults() {
    if (this.verbose) {
      console.log("\n=== Detailed Results ===\n");
      this.results.forEach((images, url) => {
        const pageSize = images.reduce((sum, img) => sum + img.size, 0);
        console.log(`\nPage: ${url}`);
        console.log(`Total Images: ${images.length}`);
        console.log(`Total Size: ${this.formatSize(pageSize)}`);

        images.forEach((img) => {
          console.log(`\n  - ${img.url}`);
          console.log(`    Size: ${this.formatSize(img.size)}`);
          console.log(`    Dimensions: ${img.width}x${img.height}`);
          console.log(`    Type: ${img.type}`);
        });
      });
    }

    let totalImages = 0;
    let totalSize = 0;
    let heaviestPage = { url: "", count: 0, size: 0 };
    let uniqueImages = new Map();

    this.results.forEach((images, url) => {
      const pageSize = images.reduce((sum, img) => sum + img.size, 0);
      totalImages += images.length;
      totalSize += pageSize;

      if (pageSize > heaviestPage.size) {
        heaviestPage = {
          url,
          count: images.length,
          size: pageSize,
        };
      }

      images.forEach((img) => {
        if (!uniqueImages.has(img.url)) {
          uniqueImages.set(img.url, {
            size: img.size,
            count: 1,
            dimensions: `${img.width}x${img.height}`,
            type: img.type,
          });
        } else {
          uniqueImages.get(img.url).count++;
        }
      });
    });

    // Sort unique images by size
    const sortedImages = Array.from(uniqueImages.entries()).sort(
      (a, b) => b[1].size - a[1].size,
    );

    console.log("\n=== Analysis Summary ===");
    console.log(`Pages Processed: ${this.results.size}`);
    console.log(`Total Image References: ${totalImages}`);
    console.log(`Unique Images: ${uniqueImages.size}`);
    console.log(`Total Size of All Images: ${this.formatSize(totalSize)}`);

    console.log("\nHeaviest Page:");
    console.log(`URL: ${heaviestPage.url}`);
    console.log(`Number of Images: ${heaviestPage.count}`);
    console.log(`Total Size: ${this.formatSize(heaviestPage.size)}`);

    console.log("\nTop 5 Largest Images:");
    sortedImages.slice(0, 5).forEach(([url, info]) => {
      console.log(`\n${url}`);
      console.log(`Size: ${this.formatSize(info.size)}`);
      console.log(`Dimensions: ${info.dimensions}`);
      console.log(`Type: ${info.type}`);
      console.log(`Used in ${info.count} page(s)`);
    });

    console.log("\nImage Types Distribution:");
    const typeStats = new Map();
    uniqueImages.forEach((info) => {
      typeStats.set(info.type, (typeStats.get(info.type) || 0) + 1);
    });
    typeStats.forEach((count, type) => {
      console.log(`  ${type}: ${count} images`);
    });
  }

  /**
   * Format size in bytes to human readable format
   */
  formatSize(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Utility function for delay
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default ImageScraper;
