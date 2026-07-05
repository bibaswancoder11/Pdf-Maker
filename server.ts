import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createServer as createViteServer } from 'vite';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';
import { createPdfFromImages, createPdfFromText, extractTextFromDocx } from './src/utils/pdfHelper';

const execFilePromise = util.promisify(execFile);
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB file limit

async function startServer() {
  const app = express();
  const PORT = 3000;

  // In-memory cache for PDF previews
  const previewCache = new Map<string, { buffer: Buffer; filename: string }>();

  // JSON and URL-encoded body parsers
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', qpdf: true });
  });

  /**
   * POST /api/upload-preview
   * Uploads a generated PDF file to store it temporarily on the server
   * so it can be previewed without browser sandboxing/blob restrictions.
   */
  app.post('/api/upload-preview', upload.single('pdf'), (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No PDF file uploaded.' });
      }

      const previewId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
      previewCache.set(previewId, {
        buffer: file.buffer,
        filename: file.originalname || 'preview.pdf',
      });

      // Automatically evict after 15 minutes to prevent memory leak
      setTimeout(() => {
        previewCache.delete(previewId);
      }, 15 * 60 * 1000);

      return res.json({ previewId });
    } catch (err: any) {
      console.error('Upload preview error:', err);
      return res.status(500).json({ error: 'Failed to upload preview file.' });
    }
  });

  /**
   * GET /api/preview/:id
   * Serves the temporarily cached PDF file inline for the browser's PDF viewer.
   */
  app.get('/api/preview/:id', (req, res) => {
    const { id } = req.params;
    const preview = previewCache.get(id);
    if (!preview) {
      return res.status(404).send('Preview expired or not found. Please re-generate the PDF.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(preview.filename)}"`);
    return res.send(preview.buffer);
  });

  /**
   * Helper to write a buffer to a unique temp file,
   * run a qpdf command, read the output file, and clean up both files.
   */
  async function runQpdfWithTempFiles(
    inputBuffer: Buffer,
    argsBuilder: (inputPath: string, outputPath: string) => string[]
  ): Promise<Buffer> {
    const tempDir = os.tmpdir();
    const uniqueId = Math.random().toString(36).substring(2, 15);
    const inputPath = path.join(tempDir, `qpdf_in_${uniqueId}.pdf`);
    const outputPath = path.join(tempDir, `qpdf_out_${uniqueId}.pdf`);

    try {
      // Write input PDF to disk
      await fs.writeFile(inputPath, inputBuffer);

      // Build arguments for qpdf
      const args = argsBuilder(inputPath, outputPath);

      // Execute qpdf
      await execFilePromise('qpdf', args);

      // Read output PDF
      const resultBuffer = await fs.readFile(outputPath);
      return resultBuffer;
    } finally {
      // Quietly clean up temp files
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    }
  }

  /**
   * Helper to apply password encryption if a password parameter is provided
   */
  async function maybeEncryptPdf(pdfBuffer: Buffer, password?: string): Promise<Buffer> {
    if (!password || password.trim() === '') {
      return pdfBuffer;
    }
    const cleanPw = password.trim();
    return await runQpdfWithTempFiles(pdfBuffer, (inPath, outPath) => [
      '--encrypt',
      cleanPw,
      cleanPw,
      '256',
      '--',
      inPath,
      outPath,
    ]);
  }

  /**
   * POST /api/convert-images
   * Upload multiple images and convert them to a single PDF
   */
  app.post('/api/convert-images', upload.array('images'), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No images uploaded.' });
      }

      const layout = (req.body.layout as any) || 'fit';
      const password = req.body.password as string | undefined;

      // Extract file buffers
      const buffers = files.map((file) => file.buffer);

      // Generate PDF
      let pdfBuffer = await createPdfFromImages(buffers, layout);

      // Password protect if requested
      pdfBuffer = await maybeEncryptPdf(pdfBuffer, password);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="images_converted.pdf"');
      return res.send(pdfBuffer);
    } catch (error: any) {
      console.error('Image to PDF error:', error);
      return res.status(500).json({ error: error.message || 'Failed to convert images to PDF.' });
    }
  });

  /**
   * POST /api/convert-document
   * Convert document (TXT, MD, DOCX) to PDF
   */
  app.post('/api/convert-document', upload.single('document'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No document uploaded.' });
      }

      const ext = path.extname(file.originalname).toLowerCase();
      const password = req.body.password as string | undefined;
      const title = req.body.title || file.originalname.replace(ext, '');

      let textContent = '';

      if (ext === '.docx') {
        textContent = await extractTextFromDocx(file.buffer);
      } else if (ext === '.txt' || ext === '.md' || ext === '.csv') {
        textContent = file.buffer.toString('utf-8');
      } else {
        return res.status(400).json({
          error: `Unsupported file format "${ext}". We support .txt, .md, .csv and .docx documents.`,
        });
      }

      let pdfBuffer = await createPdfFromText(textContent, title);
      pdfBuffer = await maybeEncryptPdf(pdfBuffer, password);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.pdf"`);
      return res.send(pdfBuffer);
    } catch (error: any) {
      console.error('Document to PDF error:', error);
      return res.status(500).json({ error: error.message || 'Failed to convert document to PDF.' });
    }
  });

  /**
   * POST /api/create-from-text
   * Create PDF from raw text input
   */
  app.post('/api/create-from-text', async (req, res) => {
    try {
      const { text, title, password, pageSize, fontSize } = req.body;

      if (!text || text.trim() === '') {
        return res.status(400).json({ error: 'Text content cannot be empty.' });
      }

      const cleanTitle = title || 'Document';
      let pdfBuffer = await createPdfFromText(text, cleanTitle, {
        pageSize: pageSize || 'A4',
        fontSize: fontSize ? parseInt(fontSize, 10) : 11,
      });

      pdfBuffer = await maybeEncryptPdf(pdfBuffer, password);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(cleanTitle)}.pdf"`);
      return res.send(pdfBuffer);
    } catch (error: any) {
      console.error('Text to PDF error:', error);
      return res.status(500).json({ error: error.message || 'Failed to generate PDF from text.' });
    }
  });

  /**
   * POST /api/pdf-security
   * Password protect, change password, or remove password of uploaded PDF
   */
  app.post('/api/pdf-security', upload.single('pdf'), async (req, res) => {
    const action = req.body.action as 'add' | 'change' | 'delete';
    const password = req.body.password as string | undefined; // Used for "add" or "current" password
    const newPassword = req.body.newPassword as string | undefined; // Used for "change"

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    if (!action) {
      return res.status(400).json({ error: 'Action parameter (add, change, delete) is required.' });
    }

    const tempDir = os.tmpdir();
    const uniqueId = Math.random().toString(36).substring(2, 15);
    const inputPath = path.join(tempDir, `sec_in_${uniqueId}.pdf`);
    const outputPath = path.join(tempDir, `sec_out_${uniqueId}.pdf`);
    const tempDecryptPath = path.join(tempDir, `sec_dec_${uniqueId}.pdf`);

    try {
      await fs.writeFile(inputPath, file.buffer);

      if (action === 'add') {
        if (!password || password.trim() === '') {
          return res.status(400).json({ error: 'Password is required to add encryption.' });
        }
        const cleanPw = password.trim();

        // Check if already password-protected first
        try {
          await execFilePromise('qpdf', ['--check', inputPath]);
        } catch (checkErr: any) {
          // If qpdf --check fails because it's encrypted, it returns code 2 or has password in output
          if (checkErr.message?.includes('password') || checkErr.stderr?.includes('password')) {
            return res.status(400).json({
              error: 'This PDF is already password-protected. Please use the "Change Password" or "Remove Password" features instead.',
            });
          }
        }

        await execFilePromise('qpdf', [
          '--encrypt',
          cleanPw,
          cleanPw,
          '256',
          '--',
          inputPath,
          outputPath,
        ]);
      } else if (action === 'change') {
        const currentPw = password?.trim();
        const nextPw = newPassword?.trim();

        if (!currentPw) {
          return res.status(400).json({ error: 'Current password is required.' });
        }
        if (!nextPw) {
          return res.status(400).json({ error: 'New password is required.' });
        }

        // Step 1: Decrypt using current password
        try {
          await execFilePromise('qpdf', [
            `--password=${currentPw}`,
            '--decrypt',
            inputPath,
            tempDecryptPath,
          ]);
        } catch (decryptErr: any) {
          return res.status(400).json({
            error: 'Failed to decrypt PDF. Please verify that the current password is correct.',
          });
        }

        // Step 2: Encrypt with new password
        await execFilePromise('qpdf', [
          '--encrypt',
          nextPw,
          nextPw,
          '256',
          '--',
          tempDecryptPath,
          outputPath,
        ]);
      } else if (action === 'delete') {
        const currentPw = password?.trim();
        if (!currentPw) {
          return res.status(400).json({ error: 'Current password is required to remove encryption.' });
        }

        // Decrypt PDF
        try {
          await execFilePromise('qpdf', [
            `--password=${currentPw}`,
            '--decrypt',
            inputPath,
            outputPath,
          ]);
        } catch (decryptErr: any) {
          return res.status(400).json({
            error: 'Failed to decrypt PDF. Please verify that the current password is correct.',
          });
        }
      } else {
        return res.status(400).json({ error: `Invalid action "${action}". Supported actions are add, change, delete.` });
      }

      const resultBuffer = await fs.readFile(outputPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${file.originalname.replace('.pdf', '')}_secured.pdf"`);
      return res.send(resultBuffer);
    } catch (error: any) {
      console.error('PDF security action error:', error);
      return res.status(500).json({ error: error.message || 'Operation failed. Please ensure the PDF is not corrupted.' });
    } finally {
      // Quietly clean up temp files
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
      await fs.unlink(tempDecryptPath).catch(() => {});
    }
  });

  // Vite dev server mounting in non-production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PDF Maker Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start PDF Maker server:', err);
});
