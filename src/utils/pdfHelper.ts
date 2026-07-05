import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import mammoth from 'mammoth';

interface PDFTextOptions {
  fontSize?: number;
  lineHeight?: number;
  margins?: { top: number; bottom: number; left: number; right: number };
  pageSize?: 'A4' | 'Letter';
}

/**
 * Normalizes any image format (WebP, GIF, SVG, BMP, TIFF, etc.) to clean PNG using sharp
 */
export async function normalizeImageToPng(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer).png().toBuffer();
  } catch (error) {
    console.error('Error converting image with sharp:', error);
    throw new Error('Failed to process image format. Please ensure it is a valid image.');
  }
}

/**
 * Dynamically resizes, optimizes and embeds any image into the PDF document.
 * This prevents server Out Of Memory (OOM) errors and extremely large PDF file sizes.
 */
export async function processAndEmbedImage(pdfDoc: any, buffer: Buffer): Promise<any> {
  try {
    const pipeline = sharp(buffer);
    const metadata = await pipeline.metadata();

    const maxDimension = 2000;
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    // Scale down extremely large images to avoid massive PDF sizes and process crash
    const needsResize = width > maxDimension || height > maxDimension;
    if (needsResize) {
      pipeline.resize({
        width: width > height ? maxDimension : undefined,
        height: height >= width ? maxDimension : undefined,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Determine output format: if it has an alpha/transparency channel, preserve PNG.
    // Otherwise, convert/optimize to JPEG which is highly compressed and fast.
    const usePng = metadata.hasAlpha || metadata.format === 'png';

    let outputBuffer: Buffer;
    let embeddedImage: any;

    if (usePng) {
      // Direct pass-through if already PNG and no resize was needed to save CPU cycles
      if (!needsResize && metadata.format === 'png') {
        outputBuffer = buffer;
      } else {
        outputBuffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();
      }
      embeddedImage = await pdfDoc.embedPng(outputBuffer);
    } else {
      // Direct pass-through if already JPEG/JPG and no resize was needed
      if (!needsResize && metadata.format === 'jpeg') {
        outputBuffer = buffer;
      } else {
        outputBuffer = await pipeline.jpeg({ quality: 85, progressive: true }).toBuffer();
      }
      embeddedImage = await pdfDoc.embedJpg(outputBuffer);
    }

    return embeddedImage;
  } catch (error) {
    console.error('Error processing/embedding image:', error);
    throw new Error('Failed to process image. Please ensure it is a valid, uncorrupted image.');
  }
}

/**
 * Converts a list of image buffers into a single PDF buffer
 */
export async function createPdfFromImages(
  images: Buffer[],
  layout: 'fit' | 'A4_portrait' | 'A4_landscape' = 'fit'
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();

  for (const imgBuffer of images) {
    const pdfImage = await processAndEmbedImage(pdfDoc, imgBuffer);

    if (layout === 'fit') {
      const { width, height } = pdfImage.scale(1);
      const page = pdfDoc.addPage([width, height]);
      page.drawImage(pdfImage, {
        x: 0,
        y: 0,
        width,
        height,
      });
    } else {
      // Standard A4 sizes (in points: 1 pt = 1/72 inch)
      // A4: 595.28 x 841.89 pt
      const isPortrait = layout === 'A4_portrait';
      const pageWidth = isPortrait ? 595.28 : 841.89;
      const pageHeight = isPortrait ? 841.89 : 595.28;

      const page = pdfDoc.addPage([pageWidth, pageHeight]);

      const margins = 40; // 40 pt margin
      const maxWidth = pageWidth - margins * 2;
      const maxHeight = pageHeight - margins * 2;

      const { width: imgW, height: imgH } = pdfImage.scale(1);
      const scale = Math.min(maxWidth / imgW, maxHeight / imgH, 1);

      const drawW = imgW * scale;
      const drawH = imgH * scale;

      // Center the image on the page
      const x = (pageWidth - drawW) / 2;
      const y = (pageHeight - drawH) / 2;

      page.drawImage(pdfImage, {
        x,
        y,
        width: drawW,
        height: drawH,
      });
    }
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Extracts raw text from DOCX
 */
export async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    console.error('Error parsing DOCX:', error);
    throw new Error('Failed to parse word document (.docx)');
  }
}

/**
 * Wraps text into lines that fit within a specified width
 */
function wrapText(text: string, width: number, font: any, fontSize: number): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (para.trim() === '') {
      lines.push('');
      continue;
    }

    const words = para.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      const textWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (textWidth > width) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          // Word is wider than page margins, force wrap it
          lines.push(word);
          currentLine = '';
        }
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Creates a formatted PDF from text/markdown content
 */
export async function createPdfFromText(
  text: string,
  title: string = 'Converted Document',
  options: PDFTextOptions = {}
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  
  // Load standard Helvetica fonts
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageSize = (options.pageSize === 'Letter' ? [612, 792] : [595.28, 841.89]) as [number, number]; // default A4
  const [pageWidth, pageHeight] = pageSize;

  const topMargin = options.margins?.top ?? 50;
  const bottomMargin = options.margins?.bottom ?? 50;
  const leftMargin = options.margins?.left ?? 50;
  const rightMargin = options.margins?.right ?? 50;

  const contentWidth = pageWidth - (leftMargin + rightMargin);
  const contentHeight = pageHeight - (topMargin + bottomMargin);

  // Helper to start a new page
  let currentPage = pdfDoc.addPage(pageSize);
  let currentY = pageHeight - topMargin;
  let pageNum = 1;

  // Add header
  const drawHeader = (page: any) => {
    page.drawText(title, {
      x: leftMargin,
      y: pageHeight - topMargin + 15,
      size: 9,
      font: helvetica,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawLine({
      start: { x: leftMargin, y: pageHeight - topMargin + 10 },
      end: { x: pageWidth - rightMargin, y: pageHeight - topMargin + 10 },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.8),
    });
  };

  // Add footer
  const drawFooter = (page: any, num: number) => {
    page.drawText(`Page ${num}`, {
      x: pageWidth - rightMargin - 40,
      y: bottomMargin - 20,
      size: 9,
      font: helvetica,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawLine({
      start: { x: leftMargin, y: bottomMargin - 10 },
      end: { x: pageWidth - rightMargin, y: bottomMargin - 10 },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.8),
    });
  };

  // Initialize first page decorations
  drawHeader(currentPage);

  const rawLines = text.split(/\r?\n/);
  
  for (const rawLine of rawLines) {
    let size = options.fontSize ?? 11;
    let font = helvetica;
    let textToDraw = rawLine;
    let spacingAfter = 14;

    // Basic Markdown-like line styling
    if (rawLine.startsWith('# ')) {
      size = 22;
      font = helveticaBold;
      textToDraw = rawLine.substring(2);
      spacingAfter = 26;
    } else if (rawLine.startsWith('## ')) {
      size = 17;
      font = helveticaBold;
      textToDraw = rawLine.substring(3);
      spacingAfter = 20;
    } else if (rawLine.startsWith('### ')) {
      size = 13;
      font = helveticaBold;
      textToDraw = rawLine.substring(4);
      spacingAfter = 16;
    } else if (rawLine.startsWith('- ') || rawLine.startsWith('* ')) {
      size = 11;
      font = helvetica;
      textToDraw = '• ' + rawLine.substring(2);
      spacingAfter = 14;
    }

    // Wrap the text line
    const wrappedLines = wrapText(textToDraw, contentWidth, font, size);

    for (const wrappedLine of wrappedLines) {
      // Check if we need a new page
      if (currentY - size < bottomMargin) {
        drawFooter(currentPage, pageNum);
        currentPage = pdfDoc.addPage(pageSize);
        pageNum++;
        drawHeader(currentPage);
        currentY = pageHeight - topMargin;
      }

      if (wrappedLine !== '') {
        currentPage.drawText(wrappedLine, {
          x: leftMargin,
          y: currentY - size,
          size,
          font,
          color: rgb(0.1, 0.1, 0.1),
        });
        currentY -= size + 4; // Add slight gap between wrapped lines
      } else {
        currentY -= 10; // Empty paragraph spacing
      }
    }

    currentY -= spacingAfter - size; // Spacing between logical paragraphs/headers
  }

  drawFooter(currentPage, pageNum);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
