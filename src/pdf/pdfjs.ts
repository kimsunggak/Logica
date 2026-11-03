// The legacy build ships polyfills for recent JS built-ins that older system
// webviews (e.g. WKWebView on older macOS, WebKitGTK) do not have yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
