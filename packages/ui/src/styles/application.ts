// Keep KaTeX in the initial stylesheet so the first rendered formula cannot
// trigger a late global style recalculation. Importing the package stylesheet
// from TypeScript also lets Vite resolve and emit its relative font assets;
// inlining it through Tailwind's CSS @import left those URLs unresolved.
import 'katex/dist/katex.min.css';
import '../index.css';
