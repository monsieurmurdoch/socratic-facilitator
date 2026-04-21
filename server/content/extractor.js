/**
 * Content Extractor
 *
 * Extracts text from various file types: PDF, URL, TXT, DOCX
 */

const pdf = require('pdf-parse');
const fs = require('fs').promises;
const {
  getOCRAvailability,
  looksLikeWeakPDFExtraction,
  extractTextFromPDFWithOCR
} = require('./ocr');

class ContentExtractor {
  /**
   * Extract text from a PDF buffer
   */
  async extractPDF(buffer) {
    try {
      const data = await pdf(buffer);
      const nativeText = data.text.trim();
      const nativeMetadata = {
        pages: data.numpages,
        info: data.info,
        extractionMethod: 'native'
      };

      if (looksLikeWeakPDFExtraction(nativeText, { pages: data.numpages })) {
        const ocr = await extractTextFromPDFWithOCR(buffer);
        if (ocr.text && ocr.text.trim().length > nativeText.length * 0.75) {
          return {
            text: ocr.text.trim(),
            metadata: {
              ...nativeMetadata,
              ocr: ocr.metadata,
              extractionMethod: 'ocr'
            }
          };
        }

        const availability = await getOCRAvailability();
        return {
          text: nativeText,
          metadata: {
            ...nativeMetadata,
            ocrAttempted: availability.available,
            ocrAvailable: availability.available,
            extractionQuality: 'weak_native'
          }
        };
      }

      return {
        text: nativeText,
        metadata: nativeMetadata
      };
    } catch (error) {
      throw new Error(`PDF extraction failed: ${error.message}`);
    }
  }

  /**
   * Extract text from a URL (fetch and parse)
   */
  async extractURL(url) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SocraticFacilitator/1.0)'
        },
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';

      // Handle different content types
      if (contentType.includes('application/pdf')) {
        const buffer = Buffer.from(await response.arrayBuffer());
        return this.extractPDF(buffer);
      }

      // Default: treat as HTML and extract text
      const html = await response.text();
      const text = this.extractTextFromHTML(html);

      return {
        text: text.trim(),
        metadata: {
          url,
          contentType
        }
      };
    } catch (error) {
      throw new Error(`URL extraction failed: ${error.message}`);
    }
  }

  /**
   * Extract text from plain text buffer
   */
  async extractText(buffer) {
    return {
      text: buffer.toString('utf-8').trim(),
      metadata: {}
    };
  }

  /**
   * Extract text from XML by stripping tags and decoding common entities.
   * No schema awareness — just enough to make element text readable to Plato.
   */
  async extractXML(buffer) {
    const raw = buffer.toString('utf-8');
    const text = raw
      .replace(/<\?xml[^?]*\?>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return { text, metadata: { extractionMethod: 'xml-stripped' } };
  }

  /**
   * Extract text based on file type
   */
  async extract(buffer, type, metadata = {}) {
    switch (type) {
      case 'pdf':
        return this.extractPDF(buffer);

      case 'url':
        return this.extractURL(metadata.url);

      case 'txt':
        return this.extractText(buffer);

      case 'xml':
        return this.extractXML(buffer);

      case 'docx':
        // Would need mammoth package for DOCX
        throw new Error('DOCX extraction not yet implemented');

      default:
        // Try as plain text
        return this.extractText(buffer);
    }
  }

  /**
   * Extract readable text from HTML
   * Simple implementation - for production, use readability or similar
   */
  extractTextFromHTML(html) {
    // Remove script and style elements
    let text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '');

    // Get text content from article or main if available
    const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

    if (articleMatch) {
      text = articleMatch[1];
    } else if (mainMatch) {
      text = mainMatch[1];
    }

    // Remove remaining HTML tags
    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    // Limit length
    if (text.length > 50000) {
      text = text.substring(0, 50000) + '... [truncated]';
    }

    return text;
  }

  /**
   * Get file type from filename or mime type
   */
  getFileType(filename, mimeType) {
    if (mimeType === 'application/pdf' || filename?.endsWith('.pdf')) {
      return 'pdf';
    }
    if (mimeType === 'text/plain' || filename?.endsWith('.txt')) {
      return 'txt';
    }
    if (filename?.endsWith('.xml') || mimeType === 'application/xml' || mimeType === 'text/xml') {
      return 'xml';
    }
    if (filename?.endsWith('.docx') || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return 'docx';
    }
    return 'other';
  }
}

module.exports = new ContentExtractor();
