/// <reference types="vite/client" />
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PdfJsLike } from './read-resume-file';

// pdf.js is large, so it downloads only when a student chooses a PDF. The legacy build keeps
// older Safari versions working; parsing runs in a worker so the page stays responsive.
export async function loadPdfJs(): Promise<PdfJsLike> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}
