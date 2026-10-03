// Reads a resume chosen in the browser into editable text. Files never leave the device here;
// the student confirms the preview before any of it becomes profile experience.
export const MAX_TEXT_BYTES = 100_000;
export const MAX_PDF_BYTES = 5_000_000;
export const MAX_PDF_PAGES = 10;
export const MAX_RESUME_CHARS = 16_000;
const PDF_TIMEOUT_MS = 20_000;
const PDFJS_ERRORS_ONLY = 0;
const PASTE_INSTEAD = 'paste the relevant text into Experience';

// The slice of the pdf.js API used here, so tests can supply the Node build or a fake.
export interface PdfJsLike {
  getDocument(params: { data: Uint8Array; isEvalSupported: boolean; disableFontFace: boolean; verbosity: number }): {
    promise: Promise<{ numPages: number; getPage(pageNumber: number): Promise<PdfPage> }>;
    destroy(): Promise<void>;
  };
}
// Text runs carry `str`; marked-content items only describe document structure.
interface PdfPage { getTextContent(): Promise<{ items: Array<{ str: string; hasEOL: boolean } | { type: string }> }>; cleanup(): void }
export interface ReadResumeOptions { loadPdfJs: () => Promise<PdfJsLike>; timeoutMs?: number }
export interface ResumeImport { text: string; notice: string }

export class ResumeImportError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ResumeImportError'; }
}

export async function readResumeFile(file: File, options: ReadResumeOptions): Promise<ResumeImport> {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const isPdf = extension === 'pdf' || file.type === 'application/pdf';
  if (!isPdf && extension !== 'txt' && extension !== 'md') throw new ResumeImportError(`Please use a PDF, .txt, or .md file. For a Word resume, save it as a PDF or ${PASTE_INSTEAD}.`);
  if (isPdf && file.size > MAX_PDF_BYTES) throw new ResumeImportError('Please choose a PDF smaller than 5 MB.');
  if (!isPdf && file.size > MAX_TEXT_BYTES) throw new ResumeImportError('Please choose a text file smaller than 100 KB.');
  const { text, pageNote } = isPdf ? await readPdf(file, options) : { text: await readText(file), pageNote: '' };
  if (!text.trim()) throw new ResumeImportError('This file is empty. Choose another file or paste your experience.');
  const charNote = text.length > MAX_RESUME_CHARS ? `Preview limited to the first 16,000 characters. Remove any personal details you don’t need before adding it.` : '';
  return { text: text.slice(0, MAX_RESUME_CHARS), notice: [pageNote, charNote].filter(Boolean).join(' ') };
}

async function readText(file: File): Promise<string> {
  try { return await file.text(); }
  catch (error) { throw new ResumeImportError(`We couldn’t read that file. Please ${PASTE_INSTEAD} instead.`, { cause: error }); }
}

async function readPdf(file: File, options: ReadResumeOptions): Promise<{ text: string; pageNote: string }> {
  const pdfjs = await options.loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  // isEvalSupported: false keeps pdf.js from compiling code found inside an untrusted PDF.
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: PDFJS_ERRORS_ONLY });
  try {
    const { pages, pageCount } = await withTimeout((async () => {
      const pdf = await task.promise;
      const pageTexts: string[] = [];
      for (let number = 1; number <= Math.min(pdf.numPages, MAX_PDF_PAGES); number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pageTexts.push(content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : '').join(''));
        page.cleanup();
      }
      return { pages: pageTexts, pageCount: pdf.numPages };
    })(), options.timeoutMs ?? PDF_TIMEOUT_MS);
    const text = tidy(pages.join('\n\n'));
    if (!text) throw new ResumeImportError(`We couldn’t find selectable text in this PDF. It may be a scanned image. Please ${PASTE_INSTEAD} instead.`);
    return { text, pageNote: pageCount > MAX_PDF_PAGES ? `Read the first ${MAX_PDF_PAGES} of ${pageCount} pages.` : '' };
  } catch (error) {
    throw pdfFailure(error);
  } finally {
    await task.destroy();
  }
}

function tidy(text: string): string {
  return text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ResumeImportError(`Reading this PDF took too long. Please ${PASTE_INSTEAD} instead.`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function pdfFailure(error: unknown): ResumeImportError {
  if (error instanceof ResumeImportError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') return new ResumeImportError(`This PDF is password-protected. Remove the password, or ${PASTE_INSTEAD}.`, { cause: error });
  if (name === 'InvalidPDFException' || name === 'FormatError') return new ResumeImportError(`This file doesn’t look like a valid PDF. Try exporting it again, or ${PASTE_INSTEAD}.`, { cause: error });
  return new ResumeImportError(`We couldn’t read that PDF. Please ${PASTE_INSTEAD} instead.`, { cause: error });
}
