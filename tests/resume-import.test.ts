import test from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_RESUME_CHARS, MAX_TEXT_BYTES, ResumeImportError, readResumeFile, type PdfJsLike } from '../src/resume/read-resume-file';
import { makePdf } from './fixtures/make-pdf';

const loadPdfJs = async (): Promise<PdfJsLike> => pdfjs;
const pdfFile = (bytes: Uint8Array<ArrayBuffer>, name = 'resume.pdf') => new File([bytes], name, { type: 'application/pdf' });
const rejectsWith = (pattern: RegExp) => (error: unknown) => error instanceof ResumeImportError && pattern.test(error.message);

test('PDF resume text is extracted line by line, in page order', async () => {
  const file = pdfFile(makePdf([['Avery Example', 'Intro to Biology (A)'], ['Python club volunteer']]));
  const result = await readResumeFile(file, { loadPdfJs });
  assert.match(result.text, /Avery Example\nIntro to Biology \(A\)/);
  assert.ok(result.text.indexOf('Intro to Biology') < result.text.indexOf('Python club volunteer'));
  assert.equal(result.notice, '');
});

test('long PDFs are read only up to the page limit, and the preview says so', async () => {
  const pages = Array.from({ length: MAX_PDF_PAGES + 2 }, (_, index) => [`Page marker ${index + 1}`]);
  const result = await readResumeFile(pdfFile(makePdf(pages)), { loadPdfJs });
  assert.match(result.text, new RegExp(`Page marker ${MAX_PDF_PAGES}\\b`));
  assert.doesNotMatch(result.text, new RegExp(`Page marker ${MAX_PDF_PAGES + 1}\\b`));
  assert.match(result.notice, new RegExp(`first ${MAX_PDF_PAGES} of ${MAX_PDF_PAGES + 2} pages`));
});

test('extracted text is limited to the profile experience size', async () => {
  // pdf.js skips text drawn off the page, so keep each page to lines that fit.
  const page = Array.from({ length: 45 }, (_, index) => `Line ${index} of a very long resume with many details`);
  const result = await readResumeFile(pdfFile(makePdf(Array.from({ length: 8 }, () => page))), { loadPdfJs });
  assert.equal(result.text.length, MAX_RESUME_CHARS);
  assert.match(result.notice, /first 16,000 characters/);
});

test('text and markdown imports still work without loading pdf.js', async () => {
  let loaded = false;
  const file = new File(['I completed an introductory biology course.'], 'background.md', { type: 'text/markdown' });
  const result = await readResumeFile(file, { loadPdfJs: async () => { loaded = true; return pdfjs; } });
  assert.equal(result.text, 'I completed an introductory biology course.');
  assert.equal(loaded, false);
});

test('a PDF without selectable text, such as a scan, asks the student to paste instead', async () => {
  await assert.rejects(readResumeFile(pdfFile(makePdf([[]])), { loadPdfJs }), rejectsWith(/scanned image/));
});

test('a file named .pdf that is not a PDF gets a clear message', async () => {
  await assert.rejects(readResumeFile(pdfFile(new TextEncoder().encode('not a pdf at all')), { loadPdfJs }), rejectsWith(/valid PDF/));
});

test('a password-protected PDF gets a specific message and the document is released', async () => {
  let destroyed = false;
  const locked: PdfJsLike = { getDocument: () => ({
    promise: Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' })),
    destroy: async () => { destroyed = true; },
  }) };
  await assert.rejects(readResumeFile(pdfFile(makePdf([['x']])), { loadPdfJs: async () => locked }), rejectsWith(/password-protected/));
  assert.equal(destroyed, true);
});

test('a PDF that never finishes loading times out and is released', async () => {
  let destroyed = false;
  const stalled: PdfJsLike = { getDocument: () => ({ promise: new Promise(() => {}), destroy: async () => { destroyed = true; } }) };
  await assert.rejects(readResumeFile(pdfFile(makePdf([['x']])), { loadPdfJs: async () => stalled, timeoutMs: 20 }), rejectsWith(/took too long/));
  assert.equal(destroyed, true);
});

test('pdf.js is disallowed from evaluating code embedded in a PDF', async () => {
  let params: unknown;
  const spy: PdfJsLike = { getDocument: (input) => { params = input; return pdfjs.getDocument(input); } };
  await readResumeFile(pdfFile(makePdf([['Avery Example']])), { loadPdfJs: async () => spy });
  assert.equal((params as { isEvalSupported: boolean }).isEvalSupported, false);
});

test('unsupported, empty, and oversized files are rejected before parsing', async () => {
  const options = { loadPdfJs: async () => { throw new Error('pdf.js must not load for rejected files'); } };
  await assert.rejects(readResumeFile(new File(['x'], 'resume.docx'), options), rejectsWith(/save it as a PDF/));
  await assert.rejects(readResumeFile(new File(['   '], 'notes.txt'), options), rejectsWith(/empty/));
  await assert.rejects(readResumeFile(new File([new Uint8Array(MAX_TEXT_BYTES + 1)], 'notes.txt'), options), rejectsWith(/smaller than 100 KB/));
  await assert.rejects(readResumeFile(pdfFile(new Uint8Array(MAX_PDF_BYTES + 1)), options), rejectsWith(/smaller than 5 MB/));
});
