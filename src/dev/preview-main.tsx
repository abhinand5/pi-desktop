/**
 * Browser preview entry — dev only, never part of the Tauri bundle.
 *
 * The scripted backend must exist before anything reads
 * `window.__TAURI_INTERNALS__`, so the mock import runs first; then the real
 * app boots unchanged in a plain browser tab served at /preview.html.
 */
import "./preview-mock";
import "../main";
